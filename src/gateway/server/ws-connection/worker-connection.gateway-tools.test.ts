import { describe, expect, it, vi } from "vitest";
import {
  WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
  WORKER_GATEWAY_TOOL_METHODS,
} from "../../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  ATTACHED_IDENTITY,
  attachHarness,
  setupWorkerProtocolTestState,
} from "./message-handler.worker.test-support.js";

const request = { generation: "surface", toolId: "tool", toolCallId: "call", arguments: {} };

describe("worker Gateway tool dispatch", () => {
  setupWorkerProtocolTestState();

  it("keeps control frames usable at capacity and retains invocations across socket loss", async () => {
    vi.useFakeTimers();
    const harness = attachHarness({ identity: ATTACHED_IDENTITY });
    const completion = createDeferredCore();
    harness.service.invokeGatewayTool.mockImplementation(async (_identity, args, sink) => {
      sink.send({
        type: "event",
        event: "worker.gatewayTool.update",
        payload: {
          generation: args.generation,
          toolCallId: args.toolCallId,
          seq: 1,
          result: { content: [{ type: "text", text: "working" }] },
        },
      });
      await completion.promise;
      return { ok: true, result: { content: [] } };
    });
    harness.sendConnect();
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 5; index += 1) {
      harness.sendRequest(
        WORKER_GATEWAY_TOOL_METHODS.invoke,
        { ...request, toolCallId: `call-${index}` },
        `invoke-${index}`,
      );
    }
    harness.sendRequest(
      WORKER_GATEWAY_TOOL_METHODS.cancel,
      { generation: request.generation, toolCallId: "call-0" },
      "cancel",
    );
    harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "busy" }, "heartbeat");
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.service.invokeGatewayTool).toHaveBeenCalledTimes(4);
    expect(harness.service.validateWorkerConnection).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: ATTACHED_IDENTITY.sessionId }),
      { toolSurface: true },
    );
    expect(harness.responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "invoke-4", ok: false }),
        expect.objectContaining({ id: "cancel", ok: true, payload: { cancelled: true } }),
        expect.objectContaining({ id: "heartbeat", ok: true }),
        expect.objectContaining({ event: "worker.gatewayTool.update" }),
      ]),
    );
    harness.cleanup();
    completion.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.responses).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "invoke-0" })]),
    );
  });

  it.each([
    { failure: "feature", reason: "method-not-allowed" },
    { failure: "authority", reason: "placement-mismatch" },
    { failure: "caller-supplied authority", reason: "invalid-frame" },
    { failure: "retired surface", reason: "method-not-allowed" },
  ] as const)("rejects $failure before dispatch", async ({ failure, reason }) => {
    vi.useFakeTimers();
    const harness = attachHarness({
      identity: {
        ...ATTACHED_IDENTITY,
        protocolFeatures:
          failure === "feature"
            ? ATTACHED_IDENTITY.protocolFeatures.filter(
                (feature) => feature !== WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
              )
            : ATTACHED_IDENTITY.protocolFeatures,
      },
    });
    harness.sendConnect();
    await vi.advanceTimersByTimeAsync(0);
    if (failure === "authority") {
      harness.service.validateWorkerConnection.mockReturnValue("placement-mismatch");
    }
    harness.sendRequest(
      failure === "retired surface" ? "worker.toolSurface" : WORKER_GATEWAY_TOOL_METHODS.invoke,
      failure === "retired surface"
        ? {}
        : failure === "caller-supplied authority"
          ? { ...request, sessionId: "other" }
          : request,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.service.invokeGatewayTool).not.toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledWith(1008, reason);
  });

  it("rejects duplicate in-flight request IDs without dispatching another operation", async () => {
    vi.useFakeTimers();
    const harness = attachHarness({ identity: ATTACHED_IDENTITY });
    const completion = createDeferredCore();
    harness.service.invokeGatewayTool.mockImplementation(async () => {
      await completion.promise;
      return { ok: true, result: { content: [] } };
    });
    harness.sendConnect();
    await vi.advanceTimersByTimeAsync(0);
    harness.sendRequest(WORKER_GATEWAY_TOOL_METHODS.invoke, request, "same-request");
    harness.sendRequest(WORKER_GATEWAY_TOOL_METHODS.invoke, request, "same-request");
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.service.invokeGatewayTool).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledWith(1008, "invalid-frame");
    completion.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
});
