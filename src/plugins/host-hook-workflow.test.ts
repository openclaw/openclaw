import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPluginHostRuntimeState,
  listPluginSessionSchedulerJobs,
} from "./host-hook-runtime.js";
import { schedulePluginSessionTurn } from "./host-hook-workflow.js";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
}));

vi.mock("../agents/tools/gateway.js", () => ({
  callGatewayTool: mocks.callGatewayTool,
}));

describe("plugin host workflow helpers", () => {
  afterEach(() => {
    mocks.callGatewayTool.mockReset();
    clearPluginHostRuntimeState();
  });

  it("tracks scheduled session turns using cron.add's top-level job id", async () => {
    mocks.callGatewayTool.mockResolvedValueOnce({
      id: "cron-top-level-id",
      payload: {
        id: "payload-body-id",
        kind: "agentTurn",
      },
    });

    await expect(
      schedulePluginSessionTurn({
        pluginId: "scheduler-fixture",
        pluginName: "Scheduler Fixture",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
        },
      }),
    ).resolves.toEqual({
      id: "cron-top-level-id",
      pluginId: "scheduler-fixture",
      sessionKey: "agent:main:main",
      kind: "session-turn",
    });

    expect(listPluginSessionSchedulerJobs()).toEqual([
      {
        id: "cron-top-level-id",
        pluginId: "scheduler-fixture",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      },
    ]);
  });
});
