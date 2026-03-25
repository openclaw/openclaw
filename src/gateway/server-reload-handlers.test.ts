import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandLane } from "../process/lanes.js";
import type { GatewayReloadPlan } from "./config-reload-plan.js";

const hoisted = vi.hoisted(() => ({
  getActiveEmbeddedRunCount: vi.fn(() => 0),
  getTotalPendingReplies: vi.fn(() => 0),
  getTotalQueueSize: vi.fn(() => 0),
  isRestartEnabled: vi.fn(() => false),
  resolveAgentMaxConcurrent: vi.fn(() => 5),
  resolveHookClientIpConfig: vi.fn(() => ({})),
  resolveSubagentMaxConcurrent: vi.fn(() => 9),
  setCommandLaneConcurrency: vi.fn(),
  setGatewaySigusr1RestartPolicy: vi.fn(),
}));

vi.mock("../agents/pi-embedded-runner/runs.js", () => ({
  getActiveEmbeddedRunCount: hoisted.getActiveEmbeddedRunCount,
}));

vi.mock("../auto-reply/reply/dispatcher-registry.js", () => ({
  getTotalPendingReplies: hoisted.getTotalPendingReplies,
}));

vi.mock("../config/agent-limits.js", () => ({
  resolveAgentMaxConcurrent: hoisted.resolveAgentMaxConcurrent,
  resolveSubagentMaxConcurrent: hoisted.resolveSubagentMaxConcurrent,
}));

vi.mock("../config/commands.js", () => ({
  isRestartEnabled: hoisted.isRestartEnabled,
}));

vi.mock("../infra/restart.js", () => ({
  deferGatewayRestartUntilIdle: vi.fn(),
  emitGatewayRestart: vi.fn(),
  setGatewaySigusr1RestartPolicy: hoisted.setGatewaySigusr1RestartPolicy,
}));

vi.mock("../process/command-queue.js", () => ({
  getTotalQueueSize: hoisted.getTotalQueueSize,
  setCommandLaneConcurrency: hoisted.setCommandLaneConcurrency,
}));

vi.mock("./server/hooks.js", () => ({
  resolveHookClientIpConfig: hoisted.resolveHookClientIpConfig,
}));

const { createGatewayReloadHandlers } = await import("./server-reload-handlers.js");

function createPlan(): GatewayReloadPlan {
  return {
    changedPaths: ["cron.maxConcurrentRuns"],
    restartGateway: false,
    restartReasons: [],
    hotReasons: ["cron.maxConcurrentRuns"],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartBrowserControl: false,
    restartCron: false,
    restartHeartbeat: false,
    restartHealthMonitor: false,
    restartChannels: new Set(),
    noopPaths: [],
  };
}

describe("createGatewayReloadHandlers", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("applies cron concurrency to the nested lane during hot reload", async () => {
    const state = {
      hooksConfig: {},
      hookClientIpConfig: {},
      heartbeatRunner: { updateConfig: vi.fn() },
      cronState: { cron: { stop: vi.fn() } },
      browserControl: null,
      channelHealthMonitor: null,
    };
    const setState = vi.fn();
    const handlers = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => state as never,
      setState,
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logBrowser: { error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: vi.fn(),
    });

    await handlers.applyHotReload(createPlan(), {
      cron: { maxConcurrentRuns: 4 },
    } as never);

    expect(hoisted.setGatewaySigusr1RestartPolicy).toHaveBeenCalledWith({
      allowExternal: false,
    });
    expect(hoisted.setCommandLaneConcurrency.mock.calls).toEqual([
      [CommandLane.Cron, 4],
      [CommandLane.Nested, 4],
      [CommandLane.Main, 5],
      [CommandLane.Subagent, 9],
    ]);
    expect(setState).toHaveBeenCalledOnce();
  });
});
