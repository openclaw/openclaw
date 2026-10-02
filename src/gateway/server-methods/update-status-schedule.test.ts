import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { UpdateCampaignController } from "../../infra/update-campaign.js";
import {
  currentUpdateCheckLifecycle,
  type UpdateCheckLifecycle,
} from "../../infra/update-check-lifecycle.js";
import { resetUpdateAvailableStateForTest } from "../../infra/update-startup.js";
import {
  getUpdateSchedule,
  resetUpdateStatusState,
  setUpdateScheduleCache,
} from "../../infra/update-status-state.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { updateStatusHandlers } from "./update-status.js";

vi.mock("../../version.js", () => ({ VERSION: "2026.9.7" }));

const history = vi.hoisted(() => vi.fn(async () => ({ activeRun: undefined, lastRun: undefined })));
const install = vi.hoisted(() => vi.fn());
vi.mock("../../infra/update-run-ledger.js", () => ({
  getUpdateRunStatusAsync: history,
  reconcileAbandonedUpdateRunsAsync: async () => {},
}));
vi.mock("../../infra/update-install-status.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-install-status.js")>()),
  resolveStartupInstallStatus: install,
}));
vi.mock("../server-restart-sentinel.js", () => ({
  getLatestUpdateRestartSentinel: () => null,
  refreshLatestUpdateRestartSentinel: async () => null,
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
  install.mockReset().mockRejectedValue(new Error("discovery unavailable"));
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
    const result = await status(
      { update: { channel: "dev", auto: { enabled: false } } },
      { refreshCheckout: true },
    );
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

it("reports a refreshed immutable preparation without enabling activation or retaining package targets", async () => {
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
  install.mockResolvedValue({
    ...discovered,
    status: { ...discovered.status, immutable: { ...immutable, prepared } },
  });

  const result = await status(
    { update: { channel: "stable", auto: { enabled: true } } },
    { refreshCheckout: true },
  );

  expect(result.schedule).toEqual({
    channel: "stable",
    autoEnabled: false,
    install: { kind: "immutable", immutable: { ...immutable, prepared } },
  });
  expect(result.updateAvailable).toBeNull();
  expect((await lifecycle.initialize()).status.immutable?.prepared).toEqual(prepared);

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
});
