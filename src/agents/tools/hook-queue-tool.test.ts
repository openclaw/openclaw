// Hook queue tool tests cover queue management action-to-RPC mapping.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookQueueTool } from "./hook-queue-tool.js";

describe("hook_queue tool", () => {
  const callGatewayMock = vi.fn();

  function createTestTool() {
    return createHookQueueTool(undefined, {
      callGatewayTool: async (method, gatewayOpts, params) =>
        await callGatewayMock({ method, params }, gatewayOpts),
    });
  }

  function lastGatewayCall() {
    return callGatewayMock.mock.calls.at(-1)?.[0] as
      | { method?: string; params?: Record<string, unknown> }
      | undefined;
  }

  beforeEach(() => {
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({ ok: true });
  });

  it("lists hook queues", async () => {
    const tool = createTestTool();

    await tool.execute("call-list", { action: "list" });

    expect(lastGatewayCall()).toEqual({ method: "hooks.queues", params: {} });
  });

  it("inspects hook queue items", async () => {
    const tool = createTestTool();

    await tool.execute("call-items", {
      action: "items",
      queueId: "bulk",
      statuses: ["queued", "running"],
      limit: 25,
      offset: 5,
    });

    expect(lastGatewayCall()).toEqual({
      method: "hooks.queue.items",
      params: {
        queueId: "bulk",
        statuses: ["queued", "running"],
        limit: 25,
        offset: 5,
      },
    });
  });

  it.each([
    ["pause", "hooks.queue.pause"],
    ["resume", "hooks.queue.resume"],
  ])("maps %s to the queue state RPC", async (action, method) => {
    const tool = createTestTool();

    await tool.execute(`call-${action}`, { action, queueId: "bulk" });

    expect(lastGatewayCall()).toEqual({ method, params: { queueId: "bulk" } });
  });

  it("requires queueId for item and state actions", async () => {
    const tool = createTestTool();

    await expect(tool.execute("call-pause", { action: "pause" })).rejects.toThrow(
      "queueId for action=pause required",
    );
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});
