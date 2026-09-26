import { describe, expect, it, vi } from "vitest";
import type {
  WorkerHelloOk,
  WorkerLiveEvent,
  WorkerTranscriptMessage,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceEventFrame,
  WorkerInferenceStartParams,
  WorkerInferenceTerminalFrame,
  WorkerInferenceTerminalOutcome,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { WorkerConnectionStoppedError, WorkerFencedError } from "./worker-connection-contract.js";
import type { WorkerConnection, WorkerConnectionState } from "./worker-connection.js";
import {
  WorkerInferenceProxyClient,
  WorkerLiveEventClient,
  WorkerTranscriptCommitClient,
} from "./worker-rpc-clients.js";

type LiveResponse = Awaited<ReturnType<WorkerConnection["requestLiveEvent"]>>;

function successResponse<T>(payload: T) {
  return { type: "res", id: "response", ok: true, payload } as const;
}

function resyncRequired(ackedSeq = 0, expectedSeq = ackedSeq + 1): LiveResponse {
  return {
    type: "res",
    id: "response",
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "Replay required",
      details: { reason: "resync-required", ackedSeq, expectedSeq },
    },
  };
}

const HELLO: WorkerHelloOk = {
  type: "worker-hello-ok",
  environmentId: "environment-1",
  sessionId: "session-1",
  ownerEpoch: 3,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-heartbeat-v1"],
  credentialExpiresAtMs: 10_000,
  policy: { heartbeatIntervalMs: 15_000, maxPayload: 65_536 },
};

function connectionHarness() {
  let state: WorkerConnectionState = { kind: "ready", hello: HELLO };
  const readyListeners = new Set<Parameters<WorkerConnection["onReady"]>[0]>();
  const terminalErrorListeners = new Set<Parameters<WorkerConnection["onTerminalError"]>[0]>();
  const inferenceEventListeners = new Set<Parameters<WorkerConnection["onInferenceEvent"]>[0]>();
  const inferenceTerminalListeners = new Set<
    Parameters<WorkerConnection["onInferenceTerminal"]>[0]
  >();
  const waitForReady = vi.fn<WorkerConnection["waitForReady"]>(async () => HELLO);
  const requestTranscriptCommit = vi.fn<WorkerConnection["requestTranscriptCommit"]>();
  const requestLiveEvent = vi.fn<WorkerConnection["requestLiveEvent"]>();
  const requestInferenceStart = vi.fn<WorkerConnection["requestInferenceStart"]>();
  const requestInferenceCancel = vi.fn<WorkerConnection["requestInferenceCancel"]>();
  const connection = {
    get state() {
      return state;
    },
    waitForReady,
    requestTranscriptCommit,
    requestLiveEvent,
    requestInferenceStart,
    requestInferenceCancel,
    onReady: (listener: Parameters<WorkerConnection["onReady"]>[0]) => {
      readyListeners.add(listener);
      return () => {
        readyListeners.delete(listener);
      };
    },
    onTerminalError: (listener: Parameters<WorkerConnection["onTerminalError"]>[0]) => {
      terminalErrorListeners.add(listener);
      return () => {
        terminalErrorListeners.delete(listener);
      };
    },
    onInferenceEvent: (listener: Parameters<WorkerConnection["onInferenceEvent"]>[0]) => {
      inferenceEventListeners.add(listener);
      return () => {
        inferenceEventListeners.delete(listener);
      };
    },
    onInferenceTerminal: (listener: Parameters<WorkerConnection["onInferenceTerminal"]>[0]) => {
      inferenceTerminalListeners.add(listener);
      return () => {
        inferenceTerminalListeners.delete(listener);
      };
    },
  } as unknown as WorkerConnection;
  return {
    connection,
    waitForReady,
    requestTranscriptCommit,
    requestLiveEvent,
    requestInferenceStart,
    requestInferenceCancel,
    emitReady: () => {
      for (const listener of readyListeners) {
        listener(HELLO);
      }
    },
    emitTerminalError: (nextState: WorkerConnectionState, error: Error) => {
      state = nextState;
      for (const listener of terminalErrorListeners) {
        listener(error);
      }
    },
    emitInferenceEvent: (frame: WorkerInferenceEventFrame) => {
      for (const listener of inferenceEventListeners) {
        listener(frame);
      }
    },
    emitInferenceTerminal: (frame: WorkerInferenceTerminalFrame) => {
      for (const listener of inferenceTerminalListeners) {
        listener(frame);
      }
    },
  };
}

function userMessage(text: string): WorkerTranscriptMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  };
}

const LIVE_EVENT: WorkerLiveEvent = {
  kind: "assistant",
  payload: { text: "local result", delta: "local result" },
};

const TERMINAL_EVENT: WorkerLiveEvent = {
  kind: "lifecycle",
  payload: { phase: "finishing", startedAt: 1, endedAt: 2 },
};

const INFERENCE_IDENTITY = {
  runEpoch: 3,
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
};

const INFERENCE_REQUEST: WorkerInferenceStartParams = {
  ...INFERENCE_IDENTITY,
  modelRef: { provider: "provider-1", model: "model-1" },
  context: { messages: [] },
  options: {},
};

function doneOutcome(): Extract<WorkerInferenceTerminalOutcome, { type: "done" }> {
  return {
    type: "done",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-responses",
      provider: "provider-1",
      model: "model-1",
      stopReason: "stop",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 2,
    },
  };
}

describe("worker transcript commit client", () => {
  it("splits semantic batches at the gateway frame byte ceiling", async () => {
    const harness = connectionHarness();
    harness.requestTranscriptCommit
      .mockResolvedValueOnce(successResponse({ entryIds: ["entry-1"], newLeafId: "leaf-1" }))
      .mockResolvedValueOnce(successResponse({ entryIds: ["entry-2"], newLeafId: "leaf-2" }));
    const client = new WorkerTranscriptCommitClient(harness.connection, {
      runEpoch: 3,
      baseLeafId: null,
    });
    const messages = [userMessage("a".repeat(40_000)), userMessage("b".repeat(40_000))];

    await expect(client.commit(messages)).resolves.toEqual({
      entryIds: ["entry-1", "entry-2"],
      newLeafId: "leaf-2",
    });

    expect(harness.requestTranscriptCommit).toHaveBeenCalledTimes(2);
    expect(harness.requestTranscriptCommit.mock.calls[0]?.[0]).toMatchObject({
      seq: 1,
      baseLeafId: null,
      messages: [messages[0]],
    });
    expect(harness.requestTranscriptCommit.mock.calls[1]?.[0]).toMatchObject({
      seq: 2,
      baseLeafId: "leaf-1",
      messages: [messages[1]],
    });
  });

  it("commits a terminal assistant message with replay near the frame ceiling", async () => {
    const harness = connectionHarness();
    harness.requestTranscriptCommit.mockResolvedValueOnce(
      successResponse({ entryIds: ["entry-1"], newLeafId: "leaf-1" }),
    );
    const client = new WorkerTranscriptCommitClient(harness.connection, {
      runEpoch: 3,
      baseLeafId: null,
    });
    const message: WorkerTranscriptMessage = {
      ...doneOutcome().message,
      provider: "openai",
      model: "gpt-5.6-luna",
      providerReplay: {
        v: 1,
        type: "openai-responses-compaction",
        data: "x".repeat(60 * 1024),
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.6-luna",
      },
    };

    await expect(client.commit([message])).resolves.toEqual({
      entryIds: ["entry-1"],
      newLeafId: "leaf-1",
    });
    expect(harness.requestTranscriptCommit).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [message] }),
    );
  });
});

describe("worker live-event client", () => {
  it("accepts out-of-order cumulative ACKs while a no-progress response has peers in flight", async () => {
    const harness = connectionHarness();
    const firstResponse = createDeferred<LiveResponse>();
    const secondResponse = createDeferred<LiveResponse>();
    const terminalResponse = createDeferred<LiveResponse>();
    harness.requestLiveEvent.mockImplementation(async (request) => {
      return await (request.seq === 1
        ? firstResponse.promise
        : request.seq === 2
          ? secondResponse.promise
          : terminalResponse.promise);
    });
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    client.enqueuePreview("run-1", LIVE_EVENT);
    client.enqueuePreview("run-1", {
      kind: "thinking",
      payload: { text: "second", delta: "second" },
    });
    const terminal = client.emitTerminal("run-1", TERMINAL_EVENT);
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledTimes(3));
    secondResponse.resolve(successResponse({ ackedSeq: 0 }));
    await Promise.resolve();
    expect(harness.requestLiveEvent).toHaveBeenCalledTimes(3);
    firstResponse.resolve(successResponse({ ackedSeq: 2 }));
    terminalResponse.resolve(successResponse({ ackedSeq: 3 }));

    await expect(terminal).resolves.toBeUndefined();
    client.dispose();
  });

  it("recovers finishing after a concurrent preview rejection wins the response race", async () => {
    const harness = connectionHarness();
    const previewResponse = createDeferred<LiveResponse>();
    const firstTerminalResponse = createDeferred<LiveResponse>();
    harness.requestLiveEvent
      .mockImplementationOnce(async () => await previewResponse.promise)
      .mockImplementationOnce(async () => await firstTerminalResponse.promise)
      .mockImplementationOnce(async (request) =>
        request.lastAckedSeq > 0 ? resyncRequired() : successResponse({ ackedSeq: 0 }),
      )
      .mockResolvedValueOnce(successResponse({ ackedSeq: 1 }));
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    client.enqueuePreview("run-1", LIVE_EVENT);
    const finishing = client.emitTerminal("run-1", TERMINAL_EVENT);
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledTimes(2));
    previewResponse.resolve({
      type: "res",
      id: "live-response-preview",
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Preview rejected",
        details: { reason: "invalid-event" },
      },
    });
    firstTerminalResponse.resolve(successResponse({ ackedSeq: 0 }));

    await expect(finishing).resolves.toBeUndefined();
    expect(harness.requestLiveEvent.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ seq: 1, lastAckedSeq: 0, event: LIVE_EVENT }),
      expect.objectContaining({ seq: 2, lastAckedSeq: 0 }),
      expect.objectContaining({ seq: 2, lastAckedSeq: 2 }),
      expect.objectContaining({ seq: 1, lastAckedSeq: 0 }),
    ]);
    client.dispose();
  });

  it("recovers finishing emitted after an earlier preview rejection", async () => {
    const harness = connectionHarness();
    const previewResponse = createDeferred<LiveResponse>();
    harness.requestLiveEvent
      .mockImplementationOnce(async () => await previewResponse.promise)
      .mockImplementationOnce(async (request) =>
        request.lastAckedSeq > 0 ? resyncRequired() : successResponse({ ackedSeq: 0 }),
      )
      .mockResolvedValueOnce(successResponse({ ackedSeq: 1 }));
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    client.enqueuePreview("run-1", LIVE_EVENT);
    previewResponse.resolve({
      type: "res",
      id: "live-response-preview",
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Preview rejected",
        details: { reason: "invalid-event" },
      },
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(harness.requestLiveEvent).toHaveBeenCalledOnce();
    client.enqueuePreview("run-1", {
      kind: "assistant",
      payload: { text: "dropped", delta: "dropped" },
    });
    expect(harness.requestLiveEvent).toHaveBeenCalledOnce();

    await expect(client.emitTerminal("run-1", TERMINAL_EVENT)).resolves.toBeUndefined();

    expect(harness.requestLiveEvent.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ seq: 1, lastAckedSeq: 0, event: LIVE_EVENT }),
      expect.objectContaining({ seq: 2, lastAckedSeq: 1 }),
      expect.objectContaining({ seq: 1, lastAckedSeq: 0 }),
    ]);
    client.dispose();
  });

  it("replays immutable sequence and payload after a resync response", async () => {
    const harness = connectionHarness();
    harness.requestLiveEvent
      .mockResolvedValueOnce(resyncRequired())
      .mockResolvedValueOnce(successResponse({ ackedSeq: 1 }))
      .mockResolvedValueOnce(successResponse({ ackedSeq: 2 }));
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    const event = {
      kind: "assistant" as const,
      payload: { text: "local result", delta: "local result" },
    };
    client.enqueuePreview("run-1", event);
    event.payload.text = "caller mutation";
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledTimes(2));
    await expect(client.emitTerminal("run-1", TERMINAL_EVENT)).resolves.toBeUndefined();

    expect(harness.requestLiveEvent).toHaveBeenCalledTimes(3);
    const first = harness.requestLiveEvent.mock.calls[0]?.[0];
    const replay = harness.requestLiveEvent.mock.calls[1]?.[0];
    expect(replay).toEqual(first);
    expect(replay?.event).not.toBe(event);
    expect(replay?.event).toEqual(LIVE_EVENT);
    expect(replay).toMatchObject({ seq: 1, lastAckedSeq: 0 });
    client.dispose();
  });

  it("renumbers the unacked tail when the gateway resets behind the local cursor", async () => {
    const harness = connectionHarness();
    let responseIndex = 0;
    harness.requestLiveEvent.mockImplementation(async () => {
      responseIndex += 1;
      if (responseIndex === 1) {
        return resyncRequired();
      }
      const ackedSeq = responseIndex === 2 ? 0 : responseIndex - 2;
      return successResponse({ ackedSeq });
    });
    const client = new WorkerLiveEventClient(harness.connection, {
      runEpoch: 3,
      initialAckedSeq: 5,
    });

    client.enqueuePreview("run-1", LIVE_EVENT);
    const secondEvent: WorkerLiveEvent = {
      kind: "assistant",
      payload: { text: "second", delta: "second" },
    };
    client.enqueuePreview("run-1", secondEvent);
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledTimes(4));

    await expect(client.emitTerminal("run-1", TERMINAL_EVENT)).resolves.toBeUndefined();
    expect(harness.requestLiveEvent.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ seq: 6, lastAckedSeq: 5, event: LIVE_EVENT }),
      expect.objectContaining({ seq: 7, lastAckedSeq: 5, event: secondEvent }),
      expect.objectContaining({ seq: 1, lastAckedSeq: 0, event: LIVE_EVENT }),
      expect.objectContaining({ seq: 2, lastAckedSeq: 0, event: secondEvent }),
      expect.objectContaining({ seq: 3, lastAckedSeq: 2, event: TERMINAL_EVENT }),
    ]);
    client.dispose();
  });

  it("recovers terminal delivery after a repeated no-progress preview resync", async () => {
    const harness = connectionHarness();
    const resyncResponse = resyncRequired();
    harness.requestLiveEvent
      .mockResolvedValueOnce(resyncResponse)
      .mockResolvedValueOnce(resyncResponse)
      .mockImplementationOnce(async (request) =>
        request.lastAckedSeq > 0 ? resyncResponse : successResponse({ ackedSeq: 0 }),
      )
      .mockResolvedValueOnce(successResponse({ ackedSeq: 1 }));
    const client = new WorkerLiveEventClient(harness.connection, {
      runEpoch: 3,
      initialAckedSeq: 5,
    });

    client.enqueuePreview("run-1", LIVE_EVENT);
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledTimes(2));
    await expect(client.emitTerminal("run-1", TERMINAL_EVENT)).resolves.toBeUndefined();
    expect(harness.requestLiveEvent).toHaveBeenCalledTimes(4);
    client.dispose();
  });

  it("rejects terminal delivery when a preview receives an inconsistent resync cursor", async () => {
    const harness = connectionHarness();
    const previewResponse = createDeferred<LiveResponse>();
    const terminalResponse = createDeferred<LiveResponse>();
    harness.requestLiveEvent.mockImplementation(async (request) =>
      request.event.kind === "lifecycle" ? terminalResponse.promise : previewResponse.promise,
    );
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    client.enqueuePreview("run-1", LIVE_EVENT);
    const terminal = client.emitTerminal("run-1", TERMINAL_EVENT);
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledTimes(2));
    previewResponse.resolve(resyncRequired(0, 2));

    await expect(terminal).rejects.toThrow("worker live-event resync cursor is inconsistent");
    terminalResponse.resolve(successResponse({ ackedSeq: 2 }));
    client.dispose();
  });

  it("drops previews and rejects terminal delivery after stop without rescheduling", async () => {
    const harness = connectionHarness();
    harness.waitForReady.mockRejectedValue(new WorkerConnectionStoppedError());
    harness.emitTerminalError({ kind: "stopped" }, new WorkerConnectionStoppedError());
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    client.enqueuePreview("run-1", LIVE_EVENT);
    await expect(client.emitTerminal("run-1", TERMINAL_EVENT)).rejects.toBeInstanceOf(
      WorkerConnectionStoppedError,
    );
    expect(harness.waitForReady).toHaveBeenCalledOnce();
    expect(harness.requestLiveEvent).not.toHaveBeenCalled();
    client.dispose();
  });

  it("rejects the terminal barrier when the worker is fenced", async () => {
    const harness = connectionHarness();
    harness.requestLiveEvent.mockImplementation(async () => await new Promise<never>(() => {}));
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    client.enqueuePreview("run-1", LIVE_EVENT);
    const terminal = client.emitTerminal("run-1", TERMINAL_EVENT);
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledTimes(2));
    harness.emitTerminalError(
      { kind: "fenced", reason: "owner-epoch-mismatch" },
      new WorkerFencedError("owner-epoch-mismatch"),
    );

    await expect(terminal).rejects.toEqual(new WorkerFencedError("owner-epoch-mismatch"));
    client.dispose();
  });
});

describe("worker inference proxy client", () => {
  it("reports stream gaps but accepts later events and the terminal outcome", async () => {
    const harness = connectionHarness();
    harness.requestInferenceStart.mockResolvedValueOnce(
      successResponse({ status: "accepted" as const }),
    );
    const client = new WorkerInferenceProxyClient(harness.connection);
    const onEvent = vi.fn();
    const onStreamGap = vi.fn();
    const terminal = doneOutcome();

    const request = {
      ...structuredClone(INFERENCE_REQUEST),
      modelRef: { ...INFERENCE_REQUEST.modelRef },
    };
    const outcome = client.start(request, { onEvent, onStreamGap });
    request.modelRef.model = "caller-mutation";
    await vi.waitFor(() => expect(harness.requestInferenceStart).toHaveBeenCalledOnce());
    expect(harness.requestInferenceStart.mock.calls[0]?.[0]).toEqual(INFERENCE_REQUEST);
    harness.emitInferenceEvent({
      type: "event",
      event: "worker.inference.event",
      payload: {
        ...INFERENCE_IDENTITY,
        seq: 1,
        event: { type: "text_start", contentIndex: 0 },
      },
    });
    harness.emitInferenceEvent({
      type: "event",
      event: "worker.inference.event",
      payload: {
        ...INFERENCE_IDENTITY,
        seq: 3,
        event: { type: "text_delta", contentIndex: 0, delta: "continued" },
      },
    });
    harness.emitInferenceTerminal({
      type: "event",
      event: "worker.inference.terminal",
      payload: { ...INFERENCE_IDENTITY, seq: 4, outcome: terminal },
    });

    await expect(outcome).resolves.toEqual(terminal);
    expect(onStreamGap).toHaveBeenCalledOnce();
    expect(onStreamGap).toHaveBeenCalledWith({ expectedSeq: 2, receivedSeq: 3 });
    expect(onEvent).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it("reattaches an active turn and consumes its replayed terminal", async () => {
    const harness = connectionHarness();
    const terminal = doneOutcome();
    harness.requestInferenceStart
      .mockResolvedValueOnce(successResponse({ status: "accepted" as const }))
      .mockImplementationOnce(async (_params, beforeResolve) => {
        const response = successResponse({ status: "replayed" as const });
        beforeResolve?.(response);
        harness.emitInferenceTerminal({
          type: "event",
          event: "worker.inference.terminal",
          payload: { ...INFERENCE_IDENTITY, seq: 1, outcome: terminal },
        });
        return response;
      });
    const client = new WorkerInferenceProxyClient(harness.connection);
    const onStreamGap = vi.fn();

    const outcome = client.start(INFERENCE_REQUEST, { onStreamGap });
    await vi.waitFor(() => expect(harness.requestInferenceStart).toHaveBeenCalledOnce());
    harness.emitInferenceEvent({
      type: "event",
      event: "worker.inference.event",
      payload: {
        ...INFERENCE_IDENTITY,
        seq: 1,
        event: { type: "text_start", contentIndex: 0 },
      },
    });
    harness.emitReady();
    await vi.waitFor(() => expect(harness.requestInferenceStart).toHaveBeenCalledTimes(2));

    await expect(outcome).resolves.toEqual(terminal);
    expect(harness.requestInferenceStart.mock.calls[1]?.[0]).toEqual(
      harness.requestInferenceStart.mock.calls[0]?.[0],
    );
    expect(onStreamGap).not.toHaveBeenCalled();
    client.dispose();
  });
});
