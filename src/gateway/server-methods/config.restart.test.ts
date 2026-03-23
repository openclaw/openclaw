import { beforeEach, describe, expect, it, vi } from "vitest";

const buildGatewayReloadPlanMock = vi.fn();
const scheduleGatewaySigusr1RestartMock = vi.fn();
const writeRestartSentinelMock = vi.fn();

vi.mock("../config-reload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config-reload.js")>();
  return {
    ...actual,
    buildGatewayReloadPlan: buildGatewayReloadPlanMock,
  };
});

vi.mock("../../infra/restart.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/restart.js")>();
  return {
    ...actual,
    scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
  };
});

vi.mock("../../infra/restart-sentinel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/restart-sentinel.js")>();
  return {
    ...actual,
    writeRestartSentinel: writeRestartSentinelMock,
  };
});

beforeEach(() => {
  buildGatewayReloadPlanMock.mockReset();
  scheduleGatewaySigusr1RestartMock.mockReset();
  writeRestartSentinelMock.mockReset();
});

describe("resolveConfigWriteRestart", () => {
  it.each([
    { kind: "config-patch" as const, mode: "config.patch" as const },
    { kind: "config-apply" as const, mode: "config.apply" as const },
  ])("skips restart scheduling for hot/noop $mode writes", async ({ kind, mode }) => {
    buildGatewayReloadPlanMock.mockReturnValue({
      restartGateway: false,
      restartReasons: [],
      hotReasons: ["agents.defaults.compaction.model"],
      reloadHooks: false,
      restartGmailWatcher: false,
      restartBrowserControl: false,
      restartCron: false,
      restartHeartbeat: false,
      restartHealthMonitor: false,
      restartChannels: new Set(),
      noopPaths: [],
      changedPaths: ["agents.defaults.compaction.model"],
    });

    const { resolveConfigWriteRestart } = await import("./config.js");
    const result = resolveConfigWriteRestart({
      changedPaths: ["agents.defaults.compaction.model"],
      requestParams: {},
      kind,
      mode,
      actor: {
        actor: "gateway-client",
        connId: "conn-1",
        deviceId: "device-1",
        clientIp: "127.0.0.1",
      },
      logGateway: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    });

    expect(result).toMatchObject({
      reloadPlan: {
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["agents.defaults.compaction.model"],
      },
      restart: null,
      sentinel: null,
    });
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(writeRestartSentinelMock).not.toHaveBeenCalled();
  });
});
