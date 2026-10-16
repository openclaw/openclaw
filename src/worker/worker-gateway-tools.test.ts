import { describe, expect, it, vi } from "vitest";
import type {
  WorkerGatewayToolResponseFrame,
  WorkerToolSurface,
} from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { toToolDefinitions } from "../agents/agent-tool-definition-adapter.js";
import { prepareCoreToolPolicy } from "../agents/prepared-tool-surface.js";
import { createToolSurfacePresentationForTest } from "../agents/tool-surface-plan.test-support.js";
import { createWorkerGatewayToolProxies } from "./worker-gateway-tools.js";

function fixture() {
  const surface: WorkerToolSurface = {
    generation: "generation-1",
    presentation: createToolSurfacePresentationForTest(),
    policy: prepareCoreToolPolicy({}),
    tools: [
      {
        id: "tool-1",
        execution: "gateway",
        replay: true,
        definition: {
          name: "sessions_send",
          label: "Session Send",
          description: "Canonical description from the Gateway.",
          parameters: { type: "object", properties: { message: { type: "string" } } },
          executionMode: "sequential",
        },
      },
    ],
  };
  const result = {
    content: [{ type: "text" as const, text: "done" }],
    details: { status: "sent" },
  };
  const client = {
    invokeGatewayTool: vi.fn<
      Parameters<typeof createWorkerGatewayToolProxies>[1]["invokeGatewayTool"]
    >(async () => ({
      type: "res",
      id: "response-1",
      ok: true,
      payload: result,
    })),
    cancelGatewayTool: vi.fn<
      Parameters<typeof createWorkerGatewayToolProxies>[1]["cancelGatewayTool"]
    >(async () => ({
      type: "res",
      id: "cancel-1",
      ok: true,
      payload: { cancelled: true },
    })),
  };
  return { surface, result, client };
}

describe("worker Gateway tool transport", () => {
  it("installs canonical definitions unchanged and forwards invocation and updates", async () => {
    const { surface, client, result } = fixture();
    surface.tools[0]!.timeout = {
      minimumMs: 60_000,
      argument: "timeoutSeconds",
      defaultSeconds: 30,
      paddingMs: 60_000,
    };
    Object.freeze(surface.tools[0]!.definition);
    client.invokeGatewayTool.mockImplementationOnce(async (_params, options) => {
      options?.onUpdate?.({ content: [{ type: "text", text: "working" }] });
      return { type: "res", id: "response-1", ok: true, payload: result };
    });
    const tools = createWorkerGatewayToolProxies(surface, client);
    expect(JSON.stringify(toToolDefinitions(tools))).toBe(
      JSON.stringify(surface.tools.map((entry) => entry.definition)),
    );
    const onUpdate = vi.fn();
    await expect(
      tools[0]!.execute("call-1", { message: "hello" }, undefined, onUpdate),
    ).resolves.toEqual(result);
    expect(client.invokeGatewayTool.mock.calls[0]?.[0]).toEqual({
      generation: "generation-1",
      toolId: "tool-1",
      toolCallId: "call-1",
      arguments: { message: "hello" },
    });
    expect(client.invokeGatewayTool.mock.calls[0]?.[1]?.replay).toBe(true);
    expect(onUpdate).toHaveBeenCalledWith({
      content: [{ type: "text", text: "working" }],
      details: undefined,
    });
    expect(client.cancelGatewayTool).not.toHaveBeenCalled();
    await expect(tools[0]!.execute("long", { timeoutSeconds: 600 })).resolves.toEqual(result);
    expect(client.invokeGatewayTool.mock.calls.map((call) => call[1]?.timeoutMs)).toEqual([
      90_000, 660_000,
    ]);
    expect(JSON.stringify(toToolDefinitions(tools))).not.toContain("paddingMs");
  });

  it("cancels the same issued invocation and rejects a late result", async () => {
    const { surface, client, result } = fixture();
    const pending = createDeferred<WorkerGatewayToolResponseFrame>();
    client.invokeGatewayTool.mockReturnValueOnce(pending.promise);
    const signal = new AbortController();
    const [tool] = createWorkerGatewayToolProxies(surface, client);
    const execution = tool!.execute("call-abort", {}, signal.signal);
    expect(client.invokeGatewayTool.mock.calls[0]?.[1]?.signal).toBe(signal.signal);
    signal.abort(new Error("turn closed"));
    expect(client.cancelGatewayTool).toHaveBeenCalledWith({
      generation: surface.generation,
      toolCallId: "call-abort",
    });
    pending.resolve({ type: "res", id: "response-late", ok: true, payload: result });
    await expect(execution).rejects.toThrow("turn closed");
    await expect(tool!.execute("already-closed", {}, signal.signal)).rejects.toThrow("turn closed");
    expect(client.invokeGatewayTool).toHaveBeenCalledTimes(1);
  });

  it("rejects non-object arguments and surfaces Gateway failures", async () => {
    const { surface, client } = fixture();
    const [tool] = createWorkerGatewayToolProxies(surface, client);
    await expect(tool!.execute("bad-args", [])).rejects.toThrow("must be an object");
    expect(client.invokeGatewayTool).not.toHaveBeenCalled();
    client.invokeGatewayTool.mockResolvedValueOnce({
      type: "res",
      id: "rejected",
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Worker tool authority is no longer current.",
        details: { reason: "method-not-allowed" },
      },
    });
    await expect(tool!.execute("stale", {})).rejects.toThrow("no longer current");
  });
});
