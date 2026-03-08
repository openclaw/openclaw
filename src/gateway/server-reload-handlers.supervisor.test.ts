import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayReloadHandlers } from "./server-reload-handlers.js";

const deferGatewayRestartUntilIdle = vi.fn();
const emitGatewayRestart = vi.fn(() => true);
const setGatewaySigusr1RestartPolicy = vi.fn();
const setCommandLaneConcurrency = vi.fn();

let totalQueueSize = 0;
let totalPendingReplies = 0;
let activeEmbeddedRuns = 0;
let activeSupervisorRuns = 0;

vi.mock("../infra/restart.js", () => ({
  deferGatewayRestartUntilIdle: (...args: unknown[]) => deferGatewayRestartUntilIdle(...args),
  emitGatewayRestart: (...args: unknown[]) => emitGatewayRestart(...args),
  setGatewaySigusr1RestartPolicy: (...args: unknown[]) => setGatewaySigusr1RestartPolicy(...args),
}));

vi.mock("../process/command-queue.js", () => ({
  getTotalQueueSize: () => totalQueueSize,
  setCommandLaneConcurrency: (...args: unknown[]) => setCommandLaneConcurrency(...args),
}));

vi.mock("../auto-reply/reply/dispatcher-registry.js", () => ({
  getTotalPendingReplies: () => totalPendingReplies,
}));

vi.mock("../agents/pi-embedded-runner/runs.js", () => ({
  getActiveEmbeddedRunCount: () => activeEmbeddedRuns,
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    getActiveCount: () => activeSupervisorRuns,
  }),
}));

describe("gateway reload handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    totalQueueSize = 0;
    totalPendingReplies = 0;
    activeEmbeddedRuns = 0;
    activeSupervisorRuns = 0;
  });

  it("defers restart when only supervisor child runs are active", () => {
    const handlers = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () =>
        ({
          hooksConfig: {},
          heartbeatRunner: { updateConfig: vi.fn() },
          cronState: { cron: { stop: vi.fn(), start: vi.fn() } },
          browserControl: null,
          channelHealthMonitor: null,
        }) as never,
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logBrowser: { error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: vi.fn(),
    });
    const onSigusr1 = () => {};
    process.on("SIGUSR1", onSigusr1);
    activeSupervisorRuns = 1;

    try {
      handlers.requestGatewayRestart(
        {
          changedPaths: ["gateway.auth"],
          restartGateway: true,
          restartReasons: ["gateway.auth"],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartBrowserControl: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          restartChannels: new Set(),
          noopPaths: [],
        },
        {},
      );
    } finally {
      process.off("SIGUSR1", onSigusr1);
    }

    expect(deferGatewayRestartUntilIdle).toHaveBeenCalledTimes(1);
    expect(emitGatewayRestart).not.toHaveBeenCalled();
    const [params] = deferGatewayRestartUntilIdle.mock.calls[0] ?? [];
    expect(params.getPendingCount()).toBe(1);
  });
});
