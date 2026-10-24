import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { UpdateCampaignController } from "../../infra/update-campaign.js";
import {
  currentUpdateCheckLifecycle,
  type UpdateCheckLifecycle,
} from "../../infra/update-check-lifecycle.js";
import type { UpdateCheckResult } from "../../infra/update-check.js";
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

function expectPartialReply(respond: unknown, payload: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(payload));
}
const unavailable = {
  code: "UNAVAILABLE",
  message: "Could not check the latest update. Try again.",
};
function trackNotifications() {
  const availableChanged = vi.fn();
  const scheduleChanged = vi.fn();
  lifecycle.onUpdateAvailableChange = availableChanged;
  lifecycle.onUpdateScheduleChange = scheduleChanged;
  return { availableChanged, scheduleChanged };
}

const baseImmutable = {
  root: "/opt/openclaw",
  currentSha: "a".repeat(40),
  currentPath: `/opt/openclaw/releases/${"a".repeat(40)}`,
};
const prepared = {
  sha: "b".repeat(40),
  path: `/opt/openclaw/releases/${"b".repeat(40)}`,
  buildDigest: "c".repeat(64),
  preparedAtMs: 123,
};
function discovered(installStatus: UpdateCheckResult) {
  return { root: installStatus.root, installReceipt: null, status: installStatus };
}
function installAt(
  installKind: UpdateCheckResult["installKind"],
  root: string | null = "/openclaw",
  extra: Partial<UpdateCheckResult> = {},
) {
  return discovered({ root, installKind, packageManager: "unknown", ...extra });
}
function makeConfig(
  channel: "dev" | "stable" | "beta" | null = "dev",
  enabled = false,
  checkOnStart?: boolean,
): OpenClawConfig {
  return { update: { channel: channel ?? undefined, auto: { enabled }, checkOnStart } };
}
function cache(next: Parameters<typeof setUpdateScheduleCache>[0]["next"]) {
  setUpdateScheduleCache({ next });
}
function stalePackageSchedule(channel: "stable" | "beta" | "dev", autoEnabled = true) {
  cache({
    channel,
    autoEnabled,
    install: { kind: "package" },
    target: { kind: "package", version: "99.0.0" },
  });
}
function immutableInstall(immutable: NonNullable<UpdateCheckResult["immutable"]>) {
  return installAt("immutable", immutable.currentPath, { immutable });
}
async function requestStatus(
  getRuntimeConfig: () => OpenClawConfig,
  params: { refreshCheckout?: boolean } = {},
  logGateway?: { warn: ReturnType<typeof vi.fn> },
) {
  const respond = vi.fn();
  await updateStatusHandlers["update.status"]!({
    params,
    respond,
    context: { getRuntimeConfig, logGateway },
  } as never);
  return respond;
}
async function status(config: OpenClawConfig, params: { refreshCheckout?: boolean } = {}) {
  const respond = await requestStatus(() => config, params);
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
      cache({
        channel: "stable",
        autoEnabled: true,
        target,
        ...(campaign ? { campaign } : {}),
      }),
  });
  return target;
}

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
  const result = await status(makeConfig("stable"));
  expect(result.schedule.campaign).toEqual(campaignOwner.getState());
  expect(result.schedule.campaign).toBeDefined();
});

it.each([
  { policy: "external", enabled: false, autoEnabled: false },
  { policy: "external", enabled: true, autoEnabled: true },
  { policy: "config", enabled: true, autoEnabled: false },
  { policy: "environment", enabled: true, autoEnabled: false },
])(
  "reports cold scheduler policy before discovery ($policy, auto=$enabled)",
  async ({ policy, enabled, autoEnabled }) => {
    if (policy === "external") {
      vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
    } else {
      vi.stubEnv("OPENCLAW_NO_AUTO_UPDATE", policy === "environment" ? "1" : "");
    }
    const currentConfig = makeConfig("dev", enabled, policy === "config" ? false : undefined);
    const result = await status(currentConfig);
    expect(result.schedule).toMatchObject({ channel: "dev", autoEnabled });
    if (policy === "external") {
      expect(result.schedule.campaign).toBeUndefined();
      expect(currentConfig.update?.auto?.enabled).toBe(enabled);
      expect(getUpdateSchedule()).toBeNull();
    }
    expect(install).not.toHaveBeenCalled();
  },
);

it("does not report a newly enabled policy as idle from an old cache", async () => {
  cache({ channel: "dev", autoEnabled: false });
  const result = await status(makeConfig("dev", true));
  expect(result.schedule.autoEnabled).toBe(true);
});

it("uses local identity for a configless cold start without fetching", async () => {
  install.mockResolvedValueOnce(installAt("package", null, { packageManager: "npm" }));
  const result = await status({ update: { auto: { enabled: false } } });
  expect(result.schedule).toMatchObject({ channel: "stable", autoEnabled: false });
  expect(install).toHaveBeenCalledExactlyOnceWith(false, expect.any(AbortSignal));
});

it("reports exhausted Git discovery without retrying from status reads and clears it on refresh", async () => {
  install.mockResolvedValueOnce(
    installAt("unknown", "/openclaw", {
      error: { status: "failed", message: "Git discovery timed out", timeoutMs: 120_000 },
    }),
  );
  await lifecycle.initialize();
  const config = { update: { channel: "dev" as const, checkOnStart: false } };
  cache({
    channel: "dev",
    autoEnabled: false,
    install: { kind: "git", git: { status: "current" } },
  });
  for (let read = 0; read < 2; read++) {
    expect((await status(config)).schedule.install).toEqual({
      kind: "unknown",
      git: { status: "unavailable", reason: "git-unavailable" },
    });
  }
  expect(install).toHaveBeenCalledOnce();
  install.mockResolvedValueOnce(installAt("package", "/openclaw", { packageManager: "npm" }));
  expect((await status(config, { refreshCheckout: true })).schedule.install).toEqual({
    kind: "package",
  });
  expect((await lifecycle.initialize()).status.installKind).toBe("package");
  expect(install).toHaveBeenCalledTimes(2);
});

it.each(["replace", "remove"])("uses current channel after history lookup (%s)", async (change) => {
  let config = makeConfig();
  cache({
    channel: "dev",
    autoEnabled: false,
    target: {
      kind: "git",
      upstreamRef: "origin/main",
      upstreamSha: "old-target",
      commitsBehind: 1,
    },
  });
  history.mockImplementationOnce(async () => {
    config = makeConfig(change === "replace" ? "beta" : null, true);
    return { activeRun: undefined, lastRun: undefined };
  });
  const respond = await requestStatus(() => config);
  if (change === "remove") {
    expect(respond).toHaveBeenCalledWith(true, { sentinel: null, updateAvailable: null });
    return;
  }
  expectPartialReply(respond, {
    effectiveChannel: "beta",
    schedule: expect.objectContaining({ channel: "beta", autoEnabled: true }),
  });
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
    const target = announcePackageCampaign();
    if (applying) {
      expect(campaignOwner.adopt().status).toBe("adopted");
    }
    install.mockResolvedValue(installAt("package", null, { packageManager: "npm" }));
    const currentConfig = makeConfig();
    const respond = await requestStatus(() => currentConfig, { refreshCheckout: true });
    expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, unavailable);
    const result = await status(currentConfig);
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
  const result = await status(makeConfig());
  expect(result.schedule).toEqual({ channel: "dev", autoEnabled: false });
});

it("keeps the optional schedule unknown when local identity cannot resolve its channel", async () => {
  const result = await status({ update: { auto: { enabled: false } } });
  expect(result).toEqual({ sentinel: null, updateAvailable: null });
  expect(getUpdateSchedule()).toBeNull();
  expect(install).toHaveBeenCalledExactlyOnceWith(false, expect.any(AbortSignal));
});

it("omits app-owned install and stale package targets from the protocol schedule", async () => {
  stalePackageSchedule("dev", false);
  install.mockResolvedValue(
    installAt("host", "/opt/OpenClaw.app/openclaw", {
      installOwner: {
        schemaVersion: 1,
        owner: "macos-app",
        displayName: "OpenClaw.app",
        updateHint: "Update OpenClaw.app to update this Gateway.",
      },
    }),
  );

  const result = await status(makeConfig(), { refreshCheckout: true });

  expect(result.schedule).toEqual({ channel: "dev", autoEnabled: false });
  expect(result.updateAvailable).toBeNull();
});

it.for([false, true])(
  "preserves a no-op refresh after initialization (applying=%s)",
  async (applying, { signal }) => {
    let currentConfig = makeConfig("beta");
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
      return discovered(createDevGitStatus());
    });
    const { availableChanged, scheduleChanged } = trackNotifications();
    const refreshing = requestStatus(() => currentConfig, { refreshCheckout: true });
    try {
      await withinTest(entered.promise, signal);
      currentConfig = makeConfig("beta");
      resume.resolve();
      const respond = await refreshing;
      expectPartialReply(respond, { effectiveChannel: "beta" });
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
    const config = makeConfig(configured ? "dev" : null, true);
    install.mockResolvedValue(discovered(createDevGitStatus()));
    await lifecycle.initialize();
    const fresh = createDevGitStatus({ branch: "HEAD" });
    install.mockResolvedValue(discovered({ ...fresh, git: { ...fresh.git, tag } }));
    const { availableChanged, scheduleChanged } = trackNotifications();
    const announce = vi.fn(async () => {});
    lifecycle.announceDevGitUpdate = announce;
    const respond = await requestStatus(() => config, { refreshCheckout: true });
    if (configured) {
      expectPartialReply(respond, {
        effectiveChannel: "dev",
        updateAvailable: expect.objectContaining({ upstreamSha: "upstream-sha" }),
      });
      expect(announce).toHaveBeenCalledOnce();
    } else {
      const effectiveChannel = tag.includes("-beta.") ? "beta" : "stable";
      expectPartialReply(respond, { effectiveChannel, updateAvailable: null });
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

it.each([
  { channel: "stable", initialized: true, refreshCheckout: true, enabled: false },
  { channel: "beta", initialized: true, refreshCheckout: true, enabled: false },
  { channel: "stable", initialized: false, refreshCheckout: true, enabled: false },
  { channel: "beta", initialized: false, refreshCheckout: true, enabled: false },
  { channel: "stable", initialized: true, refreshCheckout: false, enabled: false },
  { channel: "stable", initialized: true, refreshCheckout: false, enabled: true },
] as const)(
  "refreshes native immutable facts ($channel, initialized=$initialized, refresh=$refreshCheckout, activation=$enabled)",
  async ({ channel, initialized, refreshCheckout, enabled }) => {
    const immutable = {
      ...baseImmutable,
      ...(enabled
        ? {
            activationEnabled: true,
            activation: {
              operationId: "10000000-0000-4000-8000-000000000001",
              phase: "starting" as const,
              previousSha: "a".repeat(40),
              candidateSha: "b".repeat(40),
            },
            lastActivation: {
              operationId: "10000000-0000-4000-8000-000000000002",
              outcome: "succeeded" as const,
              selectedSha: "a".repeat(40),
              verifiedAtMs: 100,
            },
          }
        : {}),
    };
    install.mockResolvedValue(immutableInstall(immutable));
    if (initialized) {
      await lifecycle.initialize();
    }
    stalePackageSchedule(channel);
    const refreshed = {
      ...immutable,
      prepared,
      ...(immutable.activation
        ? { activation: { ...immutable.activation, phase: "verifying" as const } }
        : {}),
    };
    install.mockResolvedValue(immutableInstall(refreshed));
    const privateStatus = vi.fn().mockResolvedValue(null);
    if (!refreshCheckout) {
      resolveManager.mockResolvedValue({ canStart: true, status: privateStatus });
    }

    const result = await status(makeConfig(channel, true), { refreshCheckout });

    expect(result.schedule).toEqual({
      channel,
      autoEnabled: false,
      install: { kind: "immutable", immutable: refreshed },
    });
    expect(result.updateAvailable).toBeNull();
    expect((await lifecycle.initialize()).status.immutable?.prepared).toEqual(prepared);
    if (refreshCheckout) {
      expect(install).toHaveBeenCalledWith(true, expect.any(AbortSignal));
    } else {
      expect(resolveManager).not.toHaveBeenCalled();
      expect(privateStatus).not.toHaveBeenCalled();
    }

    install.mockResolvedValue(installAt("unknown", immutable.currentPath));
    const unowned = await status(makeConfig(channel), { refreshCheckout: true });
    expect(unowned.schedule.install).toEqual({ kind: "unknown" });
  },
);

it.each([false, true])(
  "preserves immutable status after optional discovery fails (refreshCheckout=%s)",
  async (refreshCheckout) => {
    install.mockResolvedValueOnce(immutableInstall(baseImmutable));
    await lifecycle.initialize();
    install.mockRejectedValueOnce(new Error("discovery unavailable"));
    const warn = vi.fn();
    const respond = await requestStatus(() => ({}), { refreshCheckout }, { warn });

    expect(warn).toHaveBeenCalledOnce();
    expect(resolveManager).not.toHaveBeenCalled();
    if (refreshCheckout) {
      expect(respond).toHaveBeenCalledWith(false, undefined, unavailable);
      expect(history).not.toHaveBeenCalled();
    } else {
      expectPartialReply(respond, {
        schedule: {
          channel: "dev",
          autoEnabled: false,
          install: { kind: "immutable", immutable: baseImmutable },
        },
      });
      expect(history).toHaveBeenCalledOnce();
    }
  },
);
