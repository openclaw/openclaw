import { describe, expect, it, vi } from "vitest";
import {
  WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE as toolFeature,
  WORKER_GATEWAY_TOOL_METHODS as methods,
} from "../../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  ATTACHED_IDENTITY,
  attachHarness,
  setupWorkerProtocolTestState,
} from "./message-handler.worker.test-support.js";

const request = { generation: "surface", toolId: "tool", toolCallId: "call", arguments: {} };
const { invoke, cancel } = methods;

async function connect(withTools = true) {
  vi.useFakeTimers();
  const protocolFeatures = ATTACHED_IDENTITY.protocolFeatures.filter(
    (feature) => withTools || feature !== toolFeature,
  );
  const harness = attachHarness({ identity: { ...ATTACHED_IDENTITY, protocolFeatures } });
  harness.sendConnect();
  await vi.advanceTimersByTimeAsync(0);
  return harness;
}

function holdInvocations(harness: ReturnType<typeof attachHarness>, sendUpdate = false) {
  const completion = createDeferredCore();
  harness.service.invokeGatewayTool.mockImplementation(async (_identity, args, sink) => {
    const { generation, toolCallId } = args;
    const result = { content: [{ type: "text" as const, text: "working" }] };
    if (sendUpdate) {
      sink.send({
        type: "event",
        event: "worker.gatewayTool.update",
        payload: { generation, toolCallId, seq: 1, result },
      });
    }
    await completion.promise;
    return { ok: true, result: { content: [] } };
  });
  return async () => {
    completion.resolve();
    await vi.advanceTimersByTimeAsync(0);
  };
}

describe("worker Gateway tool dispatch", () => {
  setupWorkerProtocolTestState();

  it("keeps control frames usable at capacity and retains invocations across socket loss", async () => {
    const harness = await connect();
    const complete = holdInvocations(harness, true);
    for (let i = 0; i < 5; i += 1) {
      harness.sendRequest(invoke, { ...request, toolCallId: `call-${i}` }, `invoke-${i}`);
    }
    const cancellation = { generation: request.generation, toolCallId: "call-0" };
    harness.sendRequest(cancel, cancellation, "cancel");
    harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "busy" }, "heartbeat");
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.service.invokeGatewayTool).toHaveBeenCalledTimes(4);
    expect(harness.service.validateWorkerConnection).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: ATTACHED_IDENTITY.sessionId }),
      { toolSurface: true },
    );
    for (const frame of [
      { id: "invoke-4", ok: false },
      { id: "cancel", ok: true, payload: { cancelled: true } },
      { id: "heartbeat", ok: true },
      { event: "worker.gatewayTool.update" },
    ]) {
      expect(harness.responses).toContainEqual(expect.objectContaining(frame));
    }
    harness.cleanup();
    await complete();
    expect(harness.responses).not.toContainEqual(expect.objectContaining({ id: "invoke-0" }));
  });

  it.each([
    ["feature", "method-not-allowed"],
    ["authority", "placement-mismatch"],
    ["caller-supplied authority", "invalid-frame", { ...request, sessionId: "other" }],
    ["retired surface", "method-not-allowed", {}, "worker.toolSurface"],
  ] as const)(
    "rejects %s before dispatch",
    async (failure, reason, params: unknown = request, method: string = invoke) => {
      const harness = await connect(failure !== "feature");
      if (failure === "authority") {
        harness.service.validateWorkerConnection.mockReturnValue("placement-mismatch");
      }
      harness.sendRequest(method, params);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.service.invokeGatewayTool).not.toHaveBeenCalled();
      expect(harness.close).toHaveBeenCalledWith(1008, reason);
    },
  );

  it("rejects duplicate in-flight request IDs without dispatching another operation", async () => {
    const harness = await connect();
    const complete = holdInvocations(harness);
    harness.sendRequest(invoke, request, "same-request");
    harness.sendRequest(invoke, request, "same-request");
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.service.invokeGatewayTool).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledWith(1008, "invalid-frame");
    await complete();
  });
});
