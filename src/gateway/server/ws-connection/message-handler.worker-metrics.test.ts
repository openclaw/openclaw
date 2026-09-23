import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
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
import { captureGatewayRpcReceivedAt, createWorkerRpcDiagnostics } from "./request-diagnostics.js";

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

describe("dedicated worker RPC diagnostics", () => {
  setupWorkerProtocolTestState();
  beforeEach(() => resetDiagnosticEventsForTest());
  afterEach(() => {
    vi.restoreAllMocks();
    resetDiagnosticEventsForTest();
  });

  it("measures FIFO admission separately from inference acceptance without delaying its ACK", async () => {
    const events = observeRequests();
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const harness = attachHarness({
      identity: ATTACHED_IDENTITY,
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
    await admit(harness);
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
      expect(inference.map((event) => event.phase)).toEqual([
        "received",
        "response",
        "handler",
        "dispatch",
      ]);
      expect(inference[1]).toMatchObject({ outcome: "ok", durationMs: 40 });
      expect(inference[2]).toMatchObject({ admissionMs: 40, durationMs: 30, outcome: "returned" });
      expect(inference[3]).toMatchObject({
        queueWaitMs: 40,
        durationMs: 70,
        outcome: "returned",
        response: "sent",
      });
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

  it.each([false, true])(
    "releases the FIFO while computer timing stays open (closed=%s)",
    async (closed) => {
      const events = observeRequests();
      const harness = attachHarness({ identity: ATTACHED_IDENTITY });
      await admit(harness);
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
      harness.sendRequest(
        "worker.computer",
        { command: "screen.snapshot", paramsJson: "{}" },
        "computer",
      );
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
        if (closed) {
          harness.close();
          expect(signal?.aborted).toBe(true);
        }
        release.resolve();
        await settled(events, 2);
        const computer = events.filter((event) => event.method === "worker.computer");
        expect(computer.filter((event) => event.phase === "response")).toMatchObject([
          { outcome: closed ? "suppressed" : "ok", durationMs: 100 },
        ]);
        expect(computer.find((event) => event.phase === "handler")).toMatchObject({
          admissionMs: 0,
          durationMs: 100,
        });
        expect(computer.at(-1)).toMatchObject({
          phase: "dispatch",
          outcome: "returned",
          queueWaitMs: 0,
        });
        expect(
          harness.responses.filter((frame) => (frame as { id?: string }).id === "computer"),
        ).toHaveLength(closed ? 0 : 1);
      } finally {
        release.resolve();
      }
    },
  );

  it("does not turn a completed computer handler into cancellation when its send closes", async () => {
    const events = observeRequests();
    const harness = attachHarness({ identity: ATTACHED_IDENTITY });
    await admit(harness);
    harness.sendResponse.mockImplementationOnce(() => {
      harness.close();
      return { kind: "unavailable" };
    });
    harness.sendRequest("worker.computer", { command: "screen.snapshot", paramsJson: "{}" });
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

  it.each(["unavailable", "serialization"] as const)(
    "records %s sender failure without a sent response",
    async (kind) => {
      const events = observeRequests();
      const harness = attachHarness({ identity: ATTACHED_IDENTITY });
      await admit(harness);
      harness.sendResponse.mockReturnValueOnce(
        kind === "serialization"
          ? { kind, error: new Error("synthetic encoding fault") }
          : { kind },
      );
      harness.sendRequest("worker.inference.start", INFERENCE_START);
      await settled(events);
      expect(events.filter((event) => event.phase === "response")).toMatchObject([
        { outcome: "unavailable" },
      ]);
      expect(events.at(-1)).toMatchObject({ phase: "dispatch", response: "unavailable" });
    },
  );

  it("records a throwing service once and preserves protocol failure", async () => {
    const events = observeRequests();
    const harness = attachHarness({ identity: ATTACHED_IDENTITY });
    await admit(harness);
    harness.service.commitTranscript.mockRejectedValueOnce(new Error("synthetic service fault"));
    harness.sendRequest("worker.transcript.commit", TRANSCRIPT_COMMIT);
    await settled(events);
    expect(events.map((event) => event.phase)).toEqual(["received", "handler", "dispatch"]);
    expect(events.slice(1)).toMatchObject([
      { outcome: "threw" },
      { outcome: "threw", response: "none" },
    ]);
    expect(harness.close).toHaveBeenCalledWith(1011, "gateway-unavailable");
    expect(JSON.stringify(events)).not.toContain("synthetic service fault");
  });

  it("buckets arbitrary methods without leaking caller values", async () => {
    const events = observeRequests();
    const harness = attachHarness({ identity: ATTACHED_IDENTITY });
    await admit(harness);
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

  it("takes no diagnostic clocks when disabled or uninterested", () => {
    const clock = vi.spyOn(performance, "now");
    expect(captureGatewayRpcReceivedAt()).toBeUndefined();
    expect(createWorkerRpcDiagnostics("worker.computer", undefined)).toBeUndefined();
    observeRequests();
    setDiagnosticsEnabledForProcess(false);
    expect(captureGatewayRpcReceivedAt()).toBeUndefined();
    expect(clock).not.toHaveBeenCalled();
  });
});
