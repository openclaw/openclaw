import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCronTool } from "./cron-tool.js";

const { callGatewayMock } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
}));

describe("cron tool runtime packet forwarding", () => {
  const executionPacketForTest = {
    foundationRefs: { constitution: "test" },
    confidenceLoop: { evidence: ["test"] },
  };
  const runtimeExecutionPacketAliases = [
    "executionPacket",
    "runtimePacket",
    "boundedExecutionPacket",
  ] as const;

  function createTestCronTool(): ReturnType<typeof createCronTool> {
    return createCronTool(undefined, {
      callGatewayTool: async (method, _gatewayOpts, params) =>
        await callGatewayMock({ method, params }),
    });
  }

  function expectSingleGatewayCallMethod(method: string) {
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const call = callGatewayMock.mock.calls[0]?.[0] as
      | { method?: string; params?: Record<string, unknown> }
      | undefined;
    expect(call?.method).toBe(method);
    return call?.params;
  }

  beforeEach(() => {
    callGatewayMock.mockClear();
    callGatewayMock.mockResolvedValue({ ok: true });
  });

  it("rejects side-effectful cron agentTurn jobs without an execution packet", async () => {
    const tool = createTestCronTool();

    await expect(
      tool.execute("call-cron-missing-execution-packet", {
        action: "add",
        job: {
          name: "edit-runtime-flow",
          schedule: { at: new Date(123).toISOString() },
          payload: { kind: "agentTurn", message: "edit the runtime packet flow" },
        },
      }),
    ).rejects.toThrow("requires an executionPacket");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("allows read-only source review cron agentTurn jobs without an execution packet", async () => {
    const tool = createTestCronTool();

    await tool.execute("call-cron-read-only-source-review", {
      action: "add",
      job: {
        name: "review-runtime-source",
        schedule: { at: new Date(123).toISOString() },
        payload: {
          kind: "agentTurn",
          message: "review source code for runtime packet lint behavior",
        },
      },
    });

    expectSingleGatewayCallMethod("cron.add");
  });

  it("allows side-effectful cron agentTurn jobs with an execution packet", async () => {
    const tool = createTestCronTool();

    await tool.execute("call-cron-with-execution-packet", {
      action: "add",
      job: {
        name: "edit-runtime-flow",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "agentTurn", message: "edit the runtime packet flow" },
        executionPacket: executionPacketForTest,
      },
    });
    expect(expectSingleGatewayCallMethod("cron.add")).not.toHaveProperty("executionPacket");
  });

  it("strips cron execution packet aliases before forwarding", async () => {
    const tool = createTestCronTool();

    for (const packetKey of runtimeExecutionPacketAliases) {
      await tool.execute(`call-cron-add-with-${packetKey}`, {
        action: "add",
        job: {
          name: "edit-runtime-flow",
          schedule: { at: new Date(123).toISOString() },
          [packetKey]: executionPacketForTest,
          payload: {
            kind: "agentTurn",
            message: "edit the runtime packet flow",
            [packetKey]: executionPacketForTest,
          },
        },
      });
      const addParams = expectSingleGatewayCallMethod("cron.add") as
        | { payload?: Record<string, unknown> }
        | undefined;
      for (const alias of runtimeExecutionPacketAliases) {
        expect(addParams).not.toHaveProperty(alias);
        expect(addParams?.payload).not.toHaveProperty(alias);
      }
      callGatewayMock.mockClear();

      await tool.execute(`call-cron-update-with-${packetKey}`, {
        action: "update",
        id: "job-1",
        patch: {
          [packetKey]: executionPacketForTest,
          payload: {
            kind: "agentTurn",
            message: "edit the runtime packet flow",
            [packetKey]: executionPacketForTest,
          },
        },
      });
      const updateParams = expectSingleGatewayCallMethod("cron.update") as
        | { id?: string; patch?: { payload?: Record<string, unknown> } & Record<string, unknown> }
        | undefined;
      expect(updateParams?.id).toBe("job-1");
      for (const alias of runtimeExecutionPacketAliases) {
        expect(updateParams?.patch).not.toHaveProperty(alias);
        expect(updateParams?.patch?.payload).not.toHaveProperty(alias);
      }
      callGatewayMock.mockClear();
    }
  });
});
