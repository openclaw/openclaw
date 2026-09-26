import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { gatewayUpdateCampaign } from "../../infra/update-campaign.js";
import { resetUpdateAvailableStateForTest } from "../../infra/update-startup.js";
import {
  getUpdateSchedule,
  resetUpdateStatusState,
  setUpdateScheduleCache,
} from "../../infra/update-status-state.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { updateStatusHandlers } from "./update-status.js";

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

beforeEach(() => {
  vi.useFakeTimers();
  resetUpdateAvailableStateForTest(createTestGatewayScheduler());
  history.mockClear();
  install.mockReset().mockRejectedValue(new Error("discovery unavailable"));
});
afterEach(() => {
  gatewayUpdateCampaign.clear();
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
  gatewayUpdateCampaign.announce({
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
  return { target, campaign: gatewayUpdateCampaign.getState() };
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
  gatewayUpdateCampaign.announce({
    target: { kind: "package", version: "99.0.0" },
    inspect: { getQueueSize: () => 1 },
    onChange: () => {},
    apply: vi.fn(),
  });
  const campaign = gatewayUpdateCampaign.getState();
  expect(campaign).toBeDefined();
  const result = await status({ update: { channel: "dev", auto: { enabled: false } } });
  expect(result.schedule).toMatchObject({ autoEnabled: false, campaign });
  expect(gatewayUpdateCampaign.getState()).toBe(campaign);
});

it("reads campaign publication after awaited run history", async () => {
  history.mockImplementationOnce(async () => {
    announcePackageCampaign();
    return { activeRun: undefined, lastRun: undefined };
  });
  const result = await status({ update: { channel: "stable", auto: { enabled: false } } });
  expect(result.schedule.campaign).toEqual(gatewayUpdateCampaign.getState());
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
  expect(gatewayUpdateCampaign.adopt().status).toBe("adopted");
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
      expect(gatewayUpdateCampaign.adopt().status).toBe("adopted");
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
      campaign: gatewayUpdateCampaign.getState(),
      autoEnabled: false,
    });
    expect(getUpdateSchedule()).toMatchObject({ channel: "stable", target });
  },
);

it("removes a settled campaign and its old channel target after history lookup", async () => {
  announcePackageCampaign();
  history.mockImplementationOnce(async () => {
    gatewayUpdateCampaign.clear();
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
