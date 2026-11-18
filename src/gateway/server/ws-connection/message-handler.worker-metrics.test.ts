import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WORKER_COMPUTER_PROTOCOL_FEATURE } from "../../../../packages/gateway-protocol/src/schema/worker-computer.js";
import {
  WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE as toolFeature,
  WORKER_GATEWAY_TOOL_METHODS as methods,
} from "../../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createRequestGate } from "./authenticated-request-dispatch.fixtures.test-support.js";
import {
  admit,
  attachHarness,
  ATTACHED_IDENTITY,
  CREDENTIAL,
  INFERENCE_EVENT,
  INFERENCE_START,
  setupWorkerProtocolTestState,
  TRANSCRIPT_COMMIT,
  waitForWorkerProtocol,
} from "./message-handler.worker.test-support.js";

type RpcEvent = Extract<DiagnosticEventPayload, { type: "gateway.rpc" }>;

function observeRequests() {
  const events: RpcEvent[] = [];
  onTestFinished(
    onInternalDiagnosticEvent(
      (event) => {
        if (event.type === "gateway.rpc") {
          events.push(event);
        }
      },
      { include: ["gateway.rpc"] },
    ),
  );
  return events;
}

async function settled(events: RpcEvent[], count = 1) {
  await waitForWorkerProtocol(() =>
    expect(events.filter((event) => event.phase === "dispatch")).toHaveLength(count),
  );
  await waitForDiagnosticEventsDrained();
}

async function connect(options: Parameters<typeof attachHarness>[0] = {}) {
  const events = observeRequests();
  const harness = attachHarness({ identity: ATTACHED_IDENTITY, ...options });
  await admit(harness);
  return { events, harness };
}

const computerRequest = { command: "screen.snapshot", paramsJson: "{}" };

describe("dedicated worker RPC", () => {
  setupWorkerProtocolTestState();
  beforeEach(() => resetDiagnosticEventsForTest());
  afterEach(() => {
    vi.restoreAllMocks();
    resetDiagnosticEventsForTest();
  });

  it.each([true, false])(
    "gates session computer RPC and preserves image responses (supported: %s)",
    async (supported) => {
      const { harness } = await connect({
        identity: {
          ...ATTACHED_IDENTITY,
          protocolFeatures: ATTACHED_IDENTITY.protocolFeatures.filter(
            (feature) => supported || feature !== WORKER_COMPUTER_PROTOCOL_FEATURE,
          ),
        },
      });
      harness.sendRequest("worker.computer", computerRequest);
      await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
      if (supported) {
        expect(harness.service.executeComputer).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: ATTACHED_IDENTITY.sessionId }),
          computerRequest,
          expect.any(AbortSignal),
        );
        expect(harness.responses[1]).toMatchObject({
          ok: true,
          payload: { resultJson: expect.stringContaining("a".repeat(128 * 1024)) },
        });
      } else {
        expect(harness.service.executeComputer).not.toHaveBeenCalled();
        expect(harness.responses[1]).toMatchObject({
          ok: false,
          error: { details: { reason: "method-not-allowed" } },
        });
      }
    },
  );

  it("measures FIFO admission separately from inference acceptance without delaying its ACK", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { events, harness } = await connect({
      onInferenceLaunch: (sink) => {
        expect(harness.responses.at(-1)).toMatchObject({
          id: "inference-request",
          ok: true,
          payload: { status: "accepted" },
        });
        now = 210;
        sink.send(INFERENCE_EVENT);
      },
    });
    expect(events).toEqual([]);
    const gate = createRequestGate();
    const result = await harness.service.commitTranscript();
    harness.service.commitTranscript.mockImplementationOnce(async () => {
      await gate.wait();
      return result;
    });
    harness.sendRequest("worker.transcript.commit", TRANSCRIPT_COMMIT, "commit-request");
    try {
      await gate.entered;
      now = 140;
      harness.sendRequest("worker.inference.start", INFERENCE_START, "inference-request");
      expect(harness.service.startInference).not.toHaveBeenCalled();
      now = 180;
      gate.release();
      await settled(events, 2);
      const inference = events.filter((event) => event.method === "worker.inference.start");
      expect(inference).toMatchObject([
        { phase: "received" },
        { phase: "response", outcome: "ok", durationMs: 40 },
        { phase: "handler", admissionMs: 40, durationMs: 30, outcome: "returned" },
        {
          phase: "dispatch",
          queueWaitMs: 40,
          durationMs: 70,
          outcome: "returned",
          response: "sent",
        },
      ]);
      expect(harness.responses.at(-1)).toEqual(INFERENCE_EVENT);
      expect(harness.close).not.toHaveBeenCalled();
      for (const value of [
        "inference-request",
        "commit-request",
        CREDENTIAL,
        "session-1",
        "hello",
      ]) {
        expect(JSON.stringify(events)).not.toContain(value);
      }
    } finally {
      gate.release();
    }
  });

  it("releases the FIFO while computer timing stays open across connection close", async () => {
    const { events, harness } = await connect();
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const gate = createRequestGate();
    let signal: AbortSignal | undefined;
    harness.service.executeComputer.mockImplementationOnce(
      async (_identity, _request, receivedSignal) => {
        signal = receivedSignal;
        await gate.wait();
        return { ok: true, result: { resultJson: "{}" } };
      },
    );
    harness.sendRequest("worker.computer", computerRequest, "computer");
    try {
      await gate.entered;
      now = 120;
      harness.sendRequest("worker.inference.start", INFERENCE_START, "inference");
      await settled(events);
      expect(
        events.filter((event) => event.method === "worker.computer").map((event) => event.phase),
      ).toEqual(["received"]);
      expect(signal?.aborted).toBe(false);
      now = 200;
      harness.close();
      expect(signal?.aborted).toBe(true);
      gate.release();
      await settled(events, 2);
      const computer = events.filter((event) => event.method === "worker.computer");
      expect(computer).toMatchObject([
        { phase: "received" },
        { phase: "response", outcome: "suppressed", durationMs: 100 },
        { phase: "handler", admissionMs: 0, durationMs: 100 },
        { phase: "dispatch", outcome: "returned", queueWaitMs: 0 },
      ]);
      expect(
        harness.responses.filter((frame) => (frame as { id?: string }).id === "computer"),
      ).toHaveLength(0);
    } finally {
      gate.release();
    }
  });

  it("does not turn a completed computer handler into cancellation when its send closes", async () => {
    const { events, harness } = await connect();
    harness.sendResponse.mockImplementationOnce(() => {
      harness.close();
      return { kind: "unavailable" };
    });
    harness.sendRequest("worker.computer", computerRequest);
    await settled(events);
    expect(events.find((event) => event.phase === "handler")).toMatchObject({
      outcome: "returned",
    });
    expect(events.at(-1)).toMatchObject({
      phase: "dispatch",
      outcome: "returned",
      response: "unavailable",
    });
  });

  it("records serialization sender failure without a sent response", async () => {
    const { events, harness } = await connect();
    harness.sendResponse.mockReturnValueOnce({
      kind: "serialization",
      error: new Error("synthetic encoding fault"),
    });
    harness.sendRequest("worker.inference.start", INFERENCE_START);
    await settled(events);
    expect(events.filter((event) => event.phase === "response")).toMatchObject([
      { outcome: "unavailable" },
    ]);
    expect(events.at(-1)).toMatchObject({ phase: "dispatch", response: "unavailable" });
  });

  it("records a throwing transcript service once and measures its error response", async () => {
    const { events, harness } = await connect();
    harness.service.commitTranscript.mockRejectedValueOnce(new Error("synthetic service fault"));
    harness.sendRequest("worker.transcript.commit", TRANSCRIPT_COMMIT);
    await settled(events);
    expect(events).toMatchObject([
      { phase: "received" },
      { phase: "handler", outcome: "threw" },
      { phase: "response", outcome: "error" },
      { phase: "dispatch", outcome: "threw", response: "sent" },
    ]);
    expect(harness.close).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain("synthetic service fault");
  });

  it("buckets arbitrary methods without leaking caller values", async () => {
    const { events, harness } = await connect();
    harness.sendRequest(
      "private-method-value",
      { private: "private-payload-value" },
      "private-request-value",
    );
    await settled(events);
    expect(new Set(events.map((event) => event.method))).toEqual(new Set(["unknown"]));
    expect(events.find((event) => event.phase === "response")).toMatchObject({ outcome: "error" });
    expect(JSON.stringify(events)).not.toContain("private-");
  });
});

const request = { generation: "surface", toolId: "tool", toolCallId: "call", arguments: {} };
const { invoke, cancel } = methods;

async function connectTools(withTools = true, sendUpdate?: boolean) {
  vi.useFakeTimers();
  const protocolFeatures = ATTACHED_IDENTITY.protocolFeatures.filter(
    (feature) => withTools || feature !== toolFeature,
  );
  const harness = attachHarness({ identity: { ...ATTACHED_IDENTITY, protocolFeatures } });
  const completion = createDeferredCore();
  if (sendUpdate !== undefined) {
    harness.service.invokeGatewayTool.mockImplementation(async (_identity, args, sink) => {
      const { generation, toolCallId } = args;
      if (sendUpdate) {
        sink.send({
          type: "event",
          event: "worker.gatewayTool.update",
          payload: { generation, toolCallId, seq: 1, result: { content: [] } },
        });
      }
      await completion.promise;
      return { ok: true, result: { content: [] } };
    });
  }
  harness.sendConnect();
  await vi.advanceTimersByTimeAsync(0);
  return { ...harness, completion };
}

describe("dedicated worker gateway tools", () => {
  setupWorkerProtocolTestState();

  it("keeps control frames usable at capacity and retains invocations across socket loss", async () => {
    const harness = await connectTools(true, true);
    for (let i = 0; i < 5; i += 1) {
      harness.sendRequest(invoke, { ...request, toolCallId: `call-${i}` }, `invoke-${i}`);
    }
    harness.sendRequest(cancel, { generation: request.generation, toolCallId: "call-0" }, "cancel");
    harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "busy" }, "heartbeat");
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.service.invokeGatewayTool).toHaveBeenCalledTimes(4);
    expect(harness.service.validateWorkerConnection).toHaveBeenCalledWith(ATTACHED_IDENTITY, {
      toolSurface: true,
    });
    for (const frame of [
      { id: "invoke-4", ok: false },
      { id: "cancel", ok: true, payload: { cancelled: true } },
      { id: "heartbeat", ok: true },
      { event: "worker.gatewayTool.update" },
    ]) {
      expect(harness.responses).toContainEqual(expect.objectContaining(frame));
    }
    harness.cleanup();
    harness.completion.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.responses).not.toContainEqual(expect.objectContaining({ id: "invoke-0" }));
  });

  it.each([
    ["feature", "method-not-allowed"],
    ["authority", "placement-mismatch"],
    ["caller-supplied authority", "invalid-frame", { ...request, sessionId: "other" }],
    ["retired surface", "method-not-allowed", {}, "worker.toolSurface"],
  ] as const)("rejects %s", async (failure, reason, params = request, method: string = invoke) => {
    const harness = await connectTools(failure !== "feature");
    if (failure === "authority") {
      harness.service.validateWorkerConnection.mockReturnValue("placement-mismatch");
    }
    harness.sendRequest(method, params);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.service.invokeGatewayTool).not.toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledWith(1008, reason);
  });

  it("rejects duplicate in-flight request IDs without dispatching another operation", async () => {
    const harness = await connectTools(true, false);
    harness.sendRequest(invoke, request, "same-request");
    harness.sendRequest(invoke, request, "same-request");
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.service.invokeGatewayTool).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledWith(1008, "invalid-frame");
    harness.completion.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
});
