import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { UpdateCampaignController } from "../../infra/update-campaign.js";
import {
  currentUpdateCheckLifecycle,
  type UpdateCheckLifecycle,
} from "../../infra/update-check-lifecycle.js";
import { resolveDevGitCommits } from "../../infra/update-git-metadata.js";
import { createDevGitStatus } from "../../infra/update-startup-git.test-support.js";
import { resetUpdateAvailableStateForTest } from "../../infra/update-startup.js";
import {
  getUpdateAvailable,
  getUpdateSchedule,
  resetUpdateStatusState,
  setUpdateScheduleCache,
} from "../../infra/update-status-state.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { updateStatusHandlers } from "./update-status.js";

vi.mock("../../version.js", () => ({ VERSION: "2026.9.7" }));

const history = vi.hoisted(() => vi.fn(async () => ({ activeRun: undefined, lastRun: undefined })));
const install = vi.hoisted(() => vi.fn());
const resolveManager = vi.hoisted(() => vi.fn());
vi.mock("../../infra/ocm-update-client.js", async (original) => ({
  ...(await original<typeof import("../../infra/ocm-update-client.js")>()),
  resolveOcmUpdateManager: resolveManager,
}));
vi.mock("../../infra/update-run-ledger.js", () => ({
  getUpdateRunStatusAsync: history,
  reconcileAbandonedUpdateRunsAsync: async () => {},
}));
vi.mock("../../infra/update-install-status.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-install-status.js")>()),
  resolveStartupInstallStatus: install,
}));
vi.mock("../../infra/update-git-metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-git-metadata.js")>()),
  resolveDevGitCommits: vi.fn(),
}));
vi.mock("../server-update-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-update-sentinel.js")>()),
  getLatestUpdateRestartSentinel: () => null,
  prepareLatestUpdateRestartSentinel: async () => null,
}));

let lifecycle: UpdateCheckLifecycle;
let campaignOwner: UpdateCampaignController;
beforeEach(() => {
  vi.useFakeTimers();
  resetUpdateAvailableStateForTest(createTestGatewayScheduler());
  lifecycle = currentUpdateCheckLifecycle();
  campaignOwner = new UpdateCampaignController(lifecycle.scheduler);
  lifecycle.campaign = campaignOwner;
  history.mockClear();
  vi.mocked(resolveDevGitCommits).mockReset().mockResolvedValue([]);
  install.mockReset().mockRejectedValue(new Error("discovery unavailable"));
  resolveManager.mockReset().mockResolvedValue(null);
});
afterEach(async () => {
  await lifecycle.stop();
  await lifecycle.scheduler.stop();
  resetUpdateStatusState();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function status(config: OpenClawConfig, params: { refreshCheckout?: boolean } = {}) {
  const respond = vi.fn();
  await updateStatusHandlers["update.status"]!({
    params,
    respond,
    context: { getRuntimeConfig: () => config },
  } as never);
  expect(respond).toHaveBeenCalledWith(true, expect.any(Object));
  return respond.mock.calls[0]![1];
}

function announcePackageCampaign() {
  const target = { kind: "package" as const, version: "99.0.0" };
  campaignOwner.announce({
    target,
    inspect: { getQueueSize: () => 1 },
    apply: vi.fn(),
    onChange: (campaign) =>
      setUpdateScheduleCache({
        next: {
          channel: "stable",
          autoEnabled: true,
          target,
          ...(campaign ? { campaign } : {}),
        },
      }),
  });
  return { target, campaign: campaignOwner.getState() };
}

it.each([false, true])(
  "reports cold configured scheduler policy without checkout discovery (auto=%s)",
  async (enabled) => {
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
    const config = { update: { channel: "dev" as const, auto: { enabled } } };
    const result = await status(config);
    expect(result.schedule).toMatchObject({ channel: "dev", autoEnabled: enabled });
    expect(result.schedule.campaign).toBeUndefined();
    expect(config.update.auto.enabled).toBe(enabled);
    expect(getUpdateSchedule()).toBeNull();
    expect(install).not.toHaveBeenCalled();
  },
);

it("preserves a live campaign while hydrating disabled policy", async () => {
  campaignOwner.announce({
    target: { kind: "package", version: "99.0.0" },
    inspect: { getQueueSize: () => 1 },
    onChange: () => {},
    apply: vi.fn(),
  });
  const campaign = campaignOwner.getState();
  expect(campaign).toBeDefined();
  const result = await status({ update: { channel: "dev", auto: { enabled: false } } });
  expect(result.schedule).toMatchObject({ autoEnabled: false, campaign });
  expect(campaignOwner.getState()).toBe(campaign);
});

it("reads campaign publication after awaited run history", async () => {
  history.mockImplementationOnce(async () => {
    announcePackageCampaign();
    return { activeRun: undefined, lastRun: undefined };
  });
  const result = await status({ update: { channel: "stable", auto: { enabled: false } } });
  expect(result.schedule.campaign).toEqual(campaignOwner.getState());
  expect(result.schedule.campaign).toBeDefined();
});

it.each(["config", "environment"] as const)(
  "reports disabled checks before discovery (%s)",
  async (disabledBy) => {
    vi.stubEnv("OPENCLAW_NO_AUTO_UPDATE", disabledBy === "environment" ? "1" : "");
    const result = await status({
      update: {
        channel: "dev",
        auto: { enabled: true },
        ...(disabledBy === "config" ? { checkOnStart: false } : {}),
      },
    });
    expect(result.schedule).toMatchObject({ channel: "dev", autoEnabled: false });
    expect(install).not.toHaveBeenCalled();
  },
);

it("does not report a newly enabled policy as idle from an old cache", async () => {
  setUpdateScheduleCache({ next: { channel: "dev", autoEnabled: false } });
  const result = await status({ update: { channel: "dev", auto: { enabled: true } } });
  expect(result.schedule.autoEnabled).toBe(true);
});

it("uses local identity for a configless cold start without fetching", async () => {
  install.mockResolvedValueOnce({
    root: null,
    installReceipt: null,
    status: { root: null, installKind: "package", packageManager: "npm" },
  });
  const result = await status({ update: { auto: { enabled: false } } });
  expect(result.schedule).toMatchObject({ channel: "stable", autoEnabled: false });
  expect(install).toHaveBeenCalledExactlyOnceWith(false, expect.any(AbortSignal));
});

it("reports exhausted Git discovery without retrying from status reads and clears it on refresh", async () => {
  install.mockResolvedValueOnce({
    root: "/openclaw",
    installReceipt: null,
    status: {
      root: "/openclaw",
      installKind: "unknown",
      packageManager: "unknown",
      error: { status: "failed", message: "Git discovery timed out", timeoutMs: 120_000 },
    },
  });
  await lifecycle.initialize();
  const config = { update: { channel: "dev" as const, checkOnStart: false } };
  setUpdateScheduleCache({
    next: {
      channel: "dev",
      autoEnabled: false,
      install: { kind: "git", git: { status: "current" } },
    },
  });
  for (let read = 0; read < 2; read++) {
    expect((await status(config)).schedule.install).toEqual({
      kind: "unknown",
      git: { status: "unavailable", reason: "git-unavailable" },
    });
  }
  expect(install).toHaveBeenCalledOnce();
  install.mockResolvedValueOnce({
    root: "/openclaw",
    installReceipt: null,
    status: { root: "/openclaw", installKind: "package", packageManager: "npm" },
  });
  expect((await status(config, { refreshCheckout: true })).schedule.install).toEqual({
    kind: "package",
  });
  expect((await lifecycle.initialize()).status.installKind).toBe("package");
  expect(install).toHaveBeenCalledTimes(2);
});

it.each(["replace", "remove"])("uses current channel after history lookup (%s)", async (change) => {
  let config: OpenClawConfig = { update: { channel: "dev", auto: { enabled: false } } };
  setUpdateScheduleCache({
    next: {
      channel: "dev",
      autoEnabled: false,
      target: {
        kind: "git",
        upstreamRef: "origin/main",
        upstreamSha: "old-target",
        commitsBehind: 1,
      },
    },
  });
  history.mockImplementationOnce(async () => {
    config = {
      update: {
        ...(change === "replace" ? { channel: "beta" as const } : {}),
        auto: { enabled: true },
      },
    };
    return { activeRun: undefined, lastRun: undefined };
  });
  const respond = vi.fn();
  await updateStatusHandlers["update.status"]!({
    params: {},
    respond,
    context: { getRuntimeConfig: () => config },
  } as never);
  if (change === "remove") {
    expect(respond).toHaveBeenCalledWith(true, { sentinel: null, updateAvailable: null });
    return;
  }
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      effectiveChannel: "beta",
      schedule: expect.objectContaining({ channel: "beta", autoEnabled: true }),
    }),
  );
  expect(respond.mock.calls[0]![1].schedule.target).toBeUndefined();
});

it("preserves the admitted campaign channel and target without publishing status reads", async () => {
  announcePackageCampaign();
  expect(campaignOwner.adopt().status).toBe("adopted");
  const schedule = getUpdateSchedule();
  const result = await status({ update: { channel: "beta", auto: { enabled: false } } });
  expect(result).toMatchObject({
    effectiveChannel: "beta",
    schedule: { ...schedule, autoEnabled: false },
  });
  expect(getUpdateSchedule()).toBe(schedule);
});

it.each([false, true])(
  "does not replace a live campaign's metadata during checkout refresh (applying=%s)",
  async (applying) => {
    const { target } = announcePackageCampaign();
    if (applying) {
      expect(campaignOwner.adopt().status).toBe("adopted");
    }
    install.mockResolvedValue({
      root: null,
      installReceipt: null,
      status: { root: null, installKind: "package", packageManager: "npm" },
    });
    const config = { update: { channel: "dev" as const, auto: { enabled: false } } };
    const respond = vi.fn();
    await updateStatusHandlers["update.status"]!({
      params: { refreshCheckout: true },
      respond,
      context: { getRuntimeConfig: () => config },
    } as never);
    expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "Could not check the latest update. Try again.",
    });
    const result = await status(config);
    expect(result.schedule).toMatchObject({
      channel: "stable",
      target,
      campaign: campaignOwner.getState(),
      autoEnabled: false,
    });
    expect(getUpdateSchedule()).toMatchObject({ channel: "stable", target });
  },
);

it("removes a settled campaign and its old channel target after history lookup", async () => {
  announcePackageCampaign();
  history.mockImplementationOnce(async () => {
    campaignOwner.clear();
    return { activeRun: undefined, lastRun: undefined };
  });
  const result = await status({ update: { channel: "dev", auto: { enabled: false } } });
  expect(result.schedule).toEqual({ channel: "dev", autoEnabled: false });
});

it("keeps the optional schedule unknown when local identity cannot resolve its channel", async () => {
  const result = await status({ update: { auto: { enabled: false } } });
  expect(result).toEqual({ sentinel: null, updateAvailable: null });
  expect(getUpdateSchedule()).toBeNull();
  expect(install).toHaveBeenCalledExactlyOnceWith(false, expect.any(AbortSignal));
});

it("omits app-owned install and stale package targets from the protocol schedule", async () => {
  setUpdateScheduleCache({
    next: {
      channel: "dev",
      autoEnabled: false,
      install: { kind: "package" },
      target: { kind: "package", version: "99.0.0" },
    },
  });
  install.mockResolvedValue({
    root: "/opt/OpenClaw.app/openclaw",
    installReceipt: null,
    status: {
      root: "/opt/OpenClaw.app/openclaw",
      installKind: "host",
      packageManager: "unknown",
      installOwner: {
        schemaVersion: 1,
        owner: "macos-app",
        displayName: "OpenClaw.app",
        updateHint: "Update OpenClaw.app to update this Gateway.",
      },
    },
  });

  const result = await status(
    { update: { channel: "dev", auto: { enabled: false } } },
    { refreshCheckout: true },
  );

  expect(result.schedule).toEqual({ channel: "dev", autoEnabled: false });
  expect(result.updateAvailable).toBeNull();
});

it.each([
  { channel: "stable", initialized: true },
  { channel: "beta", initialized: true },
  { channel: "stable", initialized: false },
  { channel: "beta", initialized: false },
] as const)(
  "reports a refreshed immutable preparation without activation on $channel with initialized=$initialized",
  async ({ channel, initialized }) => {
    const immutable = {
      root: "/opt/openclaw",
      currentSha: "a".repeat(40),
      currentPath: `/opt/openclaw/releases/${"a".repeat(40)}`,
    };
    const discovered = {
      root: immutable.currentPath,
      installReceipt: null,
      status: {
        root: immutable.currentPath,
        installKind: "immutable",
        packageManager: "unknown",
        immutable,
      },
    };
    install.mockResolvedValue(discovered);
    if (initialized) {
      await lifecycle.initialize();
    }
    setUpdateScheduleCache({
      next: {
        channel,
        autoEnabled: true,
        install: { kind: "package" },
        target: { kind: "package", version: "99.0.0" },
      },
    });
    const prepared = {
      sha: "b".repeat(40),
      path: `/opt/openclaw/releases/${"b".repeat(40)}`,
      buildDigest: "c".repeat(64),
      preparedAtMs: 123,
    };
    install.mockResolvedValue({
      ...discovered,
      status: { ...discovered.status, immutable: { ...immutable, prepared } },
    });

    const result = await status(
      { update: { channel, auto: { enabled: true } } },
      { refreshCheckout: true },
    );

    expect(result.schedule).toEqual({
      channel,
      autoEnabled: false,
      install: { kind: "immutable", immutable: { ...immutable, prepared } },
    });
    expect(result.updateAvailable).toBeNull();
    expect(install).toHaveBeenCalledWith(true, expect.any(AbortSignal));
    expect((await lifecycle.initialize()).status.immutable?.prepared).toEqual(prepared);

    install.mockResolvedValue({
      root: immutable.currentPath,
      installReceipt: null,
      status: { root: immutable.currentPath, installKind: "unknown", packageManager: "unknown" },
    });
    const unowned = await status(
      { update: { channel, auto: { enabled: false } } },
      { refreshCheckout: true },
    );
    expect(unowned.schedule.install).toEqual({ kind: "unknown" });
  },
);

it.for([
  { channel: "beta", applying: false },
  { channel: "beta", applying: true },
] as const)(
  "preserves a no-op refresh after initialization (applying=$applying)",
  async ({ channel, applying }, { signal }) => {
    let config: OpenClawConfig = { update: { channel: "beta", auto: { enabled: false } } };
    if (applying) {
      announcePackageCampaign();
      expect(campaignOwner.adopt().status).toBe("adopted");
    }
    const priorSchedule = getUpdateSchedule();
    const priorCampaign = campaignOwner.getState();
    const entered = createDeferred();
    const resume = createDeferred();
    install.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return { root: "/opt/openclaw", installReceipt: null, status: createDevGitStatus() };
    });
    const availableChanged = vi.fn();
    const scheduleChanged = vi.fn();
    lifecycle.onUpdateAvailableChange = availableChanged;
    lifecycle.onUpdateScheduleChange = scheduleChanged;
    const respond = vi.fn();
    const refreshing = updateStatusHandlers["update.status"]!({
      params: { refreshCheckout: true },
      respond,
      context: { getRuntimeConfig: () => config },
    } as never);
    try {
      await withinTest(entered.promise, signal);
      config = { update: { ...(channel ? { channel } : {}), auto: { enabled: false } } };
      resume.resolve();
      await refreshing;
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ effectiveChannel: "beta" }),
      );
      expect(install).toHaveBeenCalledExactlyOnceWith(false, expect.any(AbortSignal));
      expect(getUpdateAvailable()).toBeNull();
      expect(getUpdateSchedule()).toBe(priorSchedule);
      expect(campaignOwner.getState()).toBe(priorCampaign);
      expect(availableChanged).not.toHaveBeenCalled();
      expect(scheduleChanged).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await refreshing;
    }
  },
);

it.for([
  { tag: "v2026.10.0-beta.1", configured: false },
  { tag: "v2026.9.30", configured: false },
  { tag: "v2026.10.0-beta.1", configured: true },
  { tag: "v2026.9.30", configured: true },
] as const)(
  "revalidates the inferred channel from fresh Git identity (tag=$tag, configured=$configured)",
  async ({ tag, configured }) => {
    const config: OpenClawConfig = {
      update: { ...(configured ? { channel: "dev" as const } : {}), auto: { enabled: true } },
    };
    install.mockResolvedValue({
      root: "/opt/openclaw",
      installReceipt: null,
      status: createDevGitStatus(),
    });
    await lifecycle.initialize();
    const fresh = createDevGitStatus({ branch: "HEAD" });
    install.mockResolvedValue({
      root: "/opt/openclaw",
      installReceipt: null,
      status: { ...fresh, git: { ...fresh.git, tag } },
    });
    const availableChanged = vi.fn();
    const scheduleChanged = vi.fn();
    const announce = vi.fn(async () => {});
    lifecycle.onUpdateAvailableChange = availableChanged;
    lifecycle.onUpdateScheduleChange = scheduleChanged;
    lifecycle.announceDevGitUpdate = announce;
    const respond = vi.fn();
    await updateStatusHandlers["update.status"]!({
      params: { refreshCheckout: true },
      respond,
      context: { getRuntimeConfig: () => config },
    } as never);
    if (configured) {
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          effectiveChannel: "dev",
          updateAvailable: expect.objectContaining({ upstreamSha: "upstream-sha" }),
        }),
      );
      expect(announce).toHaveBeenCalledOnce();
    } else {
      const effectiveChannel = tag.includes("-beta.") ? "beta" : "stable";
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ effectiveChannel, updateAvailable: null }),
      );
      expect(getUpdateAvailable()).toBeNull();
      expect(getUpdateSchedule()).toMatchObject({ channel: effectiveChannel });
      expect(getUpdateSchedule()?.target).toBeUndefined();
      expect(lifecycle.installStatus?.status.git?.tag).toBe(tag);
      expect(availableChanged).not.toHaveBeenCalled();
      expect(scheduleChanged).toHaveBeenCalledExactlyOnceWith(getUpdateSchedule());
      expect(announce).not.toHaveBeenCalled();
    }
  },
);

it.each([false, true])(
  "refreshes native immutable facts on ordinary status without consulting OCM (enabled=%s)",
  async (enabled) => {
    const immutable = {
      root: "/opt/openclaw",
      currentSha: "a".repeat(40),
      currentPath: `/opt/openclaw/releases/${"a".repeat(40)}`,
      ...(enabled
        ? {
            activationEnabled: true,
            activation: {
              operationId: "10000000-0000-4000-8000-000000000001",
              phase: "starting",
              previousSha: "a".repeat(40),
              candidateSha: "b".repeat(40),
            },
            lastActivation: {
              operationId: "10000000-0000-4000-8000-000000000002",
              outcome: "succeeded",
              selectedSha: "a".repeat(40),
              verifiedAtMs: 100,
            },
          }
        : {}),
    };
    const discovered = {
      root: immutable.currentPath,
      installReceipt: null,
      status: {
        root: immutable.currentPath,
        installKind: "immutable",
        packageManager: "unknown",
        immutable,
      },
    };
    install.mockResolvedValue(discovered);
    await lifecycle.initialize();
    setUpdateScheduleCache({
      next: {
        channel: "stable",
        autoEnabled: true,
        install: { kind: "package" },
        target: { kind: "package", version: "99.0.0" },
      },
    });
    const prepared = {
      sha: "b".repeat(40),
      path: `/opt/openclaw/releases/${"b".repeat(40)}`,
      buildDigest: "c".repeat(64),
      preparedAtMs: 123,
    };
    const refreshed = {
      ...immutable,
      prepared,
      ...(immutable.activation
        ? { activation: { ...immutable.activation, phase: "verifying" } }
        : {}),
    };
    install.mockResolvedValue({
      ...discovered,
      status: { ...discovered.status, immutable: refreshed },
    });
    const privateStatus = vi.fn().mockResolvedValue(null);
    resolveManager.mockResolvedValue({ canStart: true, status: privateStatus });

    const result = await status({ update: { channel: "stable", auto: { enabled: true } } });

    expect(result.schedule).toEqual({
      channel: "stable",
      autoEnabled: false,
      install: { kind: "immutable", immutable: refreshed },
    });
    expect(result.updateAvailable).toBeNull();
    expect((await lifecycle.initialize()).status.immutable?.prepared).toEqual(prepared);
    expect(resolveManager).not.toHaveBeenCalled();
    expect(privateStatus).not.toHaveBeenCalled();

    install.mockResolvedValue({
      root: immutable.currentPath,
      installReceipt: null,
      status: { root: immutable.currentPath, installKind: "unknown", packageManager: "unknown" },
    });
    const unowned = await status(
      { update: { channel: "stable", auto: { enabled: false } } },
      { refreshCheckout: true },
    );
    expect(unowned.schedule.install).toEqual({ kind: "unknown" });
  },
);

it.each([false, true])(
  "preserves immutable status after optional discovery fails (refreshCheckout=%s)",
  async (refreshCheckout) => {
    const immutable = {
      root: "/opt/openclaw",
      currentSha: "a".repeat(40),
      currentPath: `/opt/openclaw/releases/${"a".repeat(40)}`,
    };
    install.mockResolvedValueOnce({
      root: immutable.currentPath,
      installReceipt: null,
      status: {
        root: immutable.currentPath,
        installKind: "immutable",
        packageManager: "unknown",
        immutable,
      },
    });
    await lifecycle.initialize();
    install.mockRejectedValueOnce(new Error("discovery unavailable"));
    const respond = vi.fn();
    const warn = vi.fn();

    await updateStatusHandlers["update.status"]!({
      params: { refreshCheckout },
      respond,
      context: { getRuntimeConfig: () => ({}), logGateway: { warn } },
    } as never);

    expect(warn).toHaveBeenCalledOnce();
    expect(resolveManager).not.toHaveBeenCalled();
    if (refreshCheckout) {
      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "UNAVAILABLE",
        message: "Could not check the latest update. Try again.",
      });
      expect(history).not.toHaveBeenCalled();
    } else {
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          schedule: {
            channel: "dev",
            autoEnabled: false,
            install: { kind: "immutable", immutable },
          },
        }),
      );
      expect(history).toHaveBeenCalledOnce();
    }
  },
);
