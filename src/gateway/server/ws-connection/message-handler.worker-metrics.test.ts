import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WORKER_COMPUTER_PROTOCOL_FEATURE } from "../../../../packages/gateway-protocol/src/schema/worker-computer.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { createDeferredCore } from "../../../shared/deferred.js";
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
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const result = await harness.service.commitTranscript();
    harness.service.commitTranscript.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return result;
    });
    harness.sendRequest("worker.transcript.commit", TRANSCRIPT_COMMIT, "commit-request");
    try {
      await entered.promise;
      now = 140;
      harness.sendRequest("worker.inference.start", INFERENCE_START, "inference-request");
      expect(harness.service.startInference).not.toHaveBeenCalled();
      now = 180;
      release.resolve();
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
      release.resolve();
    }
  });

  it("releases the FIFO while computer timing stays open across connection close", async () => {
    const { events, harness } = await connect();
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let signal: AbortSignal | undefined;
    harness.service.executeComputer.mockImplementationOnce(
      async (_identity, _request, receivedSignal) => {
        signal = receivedSignal;
        entered.resolve();
        await release.promise;
        return { ok: true, result: { resultJson: "{}" } };
      },
    );
    harness.sendRequest("worker.computer", computerRequest, "computer");
    try {
      await entered.promise;
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
      release.resolve();
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
      release.resolve();
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
