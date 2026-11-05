import { expect, it, onTestFinished, vi } from "vitest";
import {
  WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES,
  type WorkerTranscriptCommitRequestFrame,
  type WorkerHelloOk,
  type WorkerLiveEvent,
  type WorkerLiveEventErrorShape,
  type WorkerTranscriptMessage,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceEventFrame,
  WorkerInferenceStartParams,
  WorkerInferenceTerminalFrame,
  WorkerInferenceTerminalOutcome,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import * as transcriptBudget from "../../packages/gateway-protocol/src/worker-transcript-budget.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { createUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import { WorkerConnectionStoppedError, WorkerFencedError } from "./worker-connection-contract.js";
import type { WorkerConnectionFrameDispatcher } from "./worker-connection-frames.js";
import { WorkerConnection, type WorkerConnectionState } from "./worker-connection.js";
import { WorkerInferenceProxyClient } from "./worker-rpc-inference-client.js";
import { WorkerLiveEventClient } from "./worker-rpc-live-event-client.js";
import { WorkerTranscriptCommitClient } from "./worker-rpc-transcript-client.js";

type TranscriptRequest = typeof WorkerConnectionFrameDispatcher.prototype.request<"transcript">;
type LiveRequest = typeof WorkerConnectionFrameDispatcher.prototype.request<"live-event">;
type InferenceStartRequest =
  typeof WorkerConnectionFrameDispatcher.prototype.request<"inference-start">;
type LiveResponse = Awaited<ReturnType<LiveRequest>>;

function successResponse<T>(payload: T) {
  return { type: "res", id: "response", ok: true, payload } as const;
}

function failureResponse(error: WorkerLiveEventErrorShape): LiveResponse {
  return { type: "res", id: "response", ok: false, error };
}

function resyncRequired(ackedSeq = 0, expectedSeq = ackedSeq + 1) {
  return failureResponse({
    code: "INVALID_REQUEST",
    message: "Replay required",
    details: { reason: "resync-required", ackedSeq, expectedSeq },
  });
}

const PREVIEW_REJECTED = failureResponse({
  code: "INVALID_REQUEST",
  message: "Preview rejected",
  details: { reason: "invalid-event" },
});

function listeners<T>() {
  const callbacks = new Set<(value: T) => void>();
  return {
    subscribe: (callback: (value: T) => void) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    emit: (value: T) => {
      for (const callback of callbacks) {
        callback(value);
      }
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
  const ready = listeners<WorkerHelloOk>();
  const terminalError = listeners<Error>();
  const waitForReady = vi.fn<WorkerConnection["waitForReady"]>(async () => HELLO);
  const commit = vi.fn<TranscriptRequest>();
  const send = vi.fn<LiveRequest>();
  const start = vi.fn<InferenceStartRequest>();
  const connection = {
    isTerminal: () => WorkerConnection.prototype.isTerminal(state),
    waitForReady,
    rpc: {
      request: (
        ...args:
          | Parameters<TranscriptRequest>
          | Parameters<LiveRequest>
          | Parameters<InferenceStartRequest>
      ) => {
        switch (args[0]) {
          case "transcript":
            return commit(...args);
          case "live-event":
            return send(...args);
          case "inference-start":
            return start(...args);
          default:
            throw new Error("Unexpected worker RPC in test");
        }
      },
      onInferenceFrame: (_frame: WorkerInferenceEventFrame | WorkerInferenceTerminalFrame) => {},
    },
    onReady: ready.subscribe,
    onTerminalError: terminalError.subscribe,
  } as unknown as WorkerConnection;
  return {
    connection,
    waitForReady,
    commit,
    send,
    start,
    emitReady: () => ready.emit(HELLO),
    emitTerminalError: (nextState: WorkerConnectionState, error: Error) => {
      state = nextState;
      terminalError.emit(error);
    },
    emitInferenceEvent: (seq: number, event: WorkerInferenceEventFrame["payload"]["event"]) =>
      connection.rpc.onInferenceFrame({
        type: "event",
        event: "worker.inference.event",
        payload: { ...INFERENCE_IDENTITY, seq, event },
      }),
    emitInferenceTerminal: (seq: number, outcome: WorkerInferenceTerminalOutcome) =>
      connection.rpc.onInferenceFrame({
        type: "event",
        event: "worker.inference.terminal",
        payload: { ...INFERENCE_IDENTITY, seq, outcome },
      }),
  };
}

function liveHarness(
  options: Partial<ConstructorParameters<typeof WorkerLiveEventClient>[1]> = {},
) {
  const harness = connectionHarness();
  const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3, ...options });
  onTestFinished(() => client.dispose());
  return { ...harness, client };
}

function transcriptHarness() {
  const harness = connectionHarness();
  return {
    ...harness,
    client: new WorkerTranscriptCommitClient(harness.connection, { runEpoch: 3, baseLeafId: null }),
  };
}

const userMessage = (text: string): WorkerTranscriptMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
});

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

const TERMINAL_OUTCOME: WorkerInferenceTerminalOutcome = {
  type: "done",
  message: {
    ...makeAgentAssistantMessage({
      content: [{ type: "text", text: "done" }],
      provider: "provider-1",
      model: "model-1",
      usage: createUsageFixture(1, 1, 2),
      timestamp: 2,
    }),
    stopReason: "stop",
  },
};

it("rejects a message beyond the frame byte ceiling before submitting it", async () => {
  const { client, ...harness } = transcriptHarness();

  await expect(client.commit([userMessage("a".repeat(80_000))])).rejects.toThrow(
    "worker transcript message exceeds the protocol payload limit",
  );
  expect(harness.commit).not.toHaveBeenCalled();
});

it("splits semantic batches at the gateway frame byte ceiling", async () => {
  const { client, ...harness } = transcriptHarness();
  harness.commit
    .mockResolvedValueOnce(successResponse({ entryIds: ["entry-1"], newLeafId: "leaf-1" }))
    .mockResolvedValueOnce(successResponse({ entryIds: ["entry-2"], newLeafId: "leaf-2" }));
  const messages = [userMessage("a".repeat(40_000)), userMessage("b".repeat(40_000))];

  await expect(client.commit(messages)).resolves.toEqual({
    entryIds: ["entry-1", "entry-2"],
    newLeafId: "leaf-2",
  });

  expect(harness.commit.mock.calls.map(([, request]) => request)).toMatchObject([
    { seq: 1, baseLeafId: null, messages: [messages[0]] },
    { seq: 2, baseLeafId: "leaf-1", messages: [messages[1]] },
  ]);
});

it("reads and serializes bounded transcript batches with linear work", async () => {
  const { client, ...harness } = transcriptHarness();
  const messages = Array.from({ length: 129 }, (_, index) => userMessage(String(index)));
  let reads = 0;
  const input = new Proxy(messages, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        reads += 1;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  harness.commit.mockImplementation(async (_kind, request) =>
    successResponse({ entryIds: [`entry-${request.seq}`], newLeafId: `leaf-${request.seq}` }),
  );

  const stringify = JSON.stringify;
  let serializedBytes = 0;
  const serialization = vi.spyOn(JSON, "stringify").mockImplementation((value) => {
    const json = stringify(value);
    serializedBytes += Buffer.byteLength(json, "utf8");
    return json;
  });
  onTestFinished(() => serialization.mockRestore());
  await client.commit(input);
  serialization.mockRestore();

  // Permit envelope and transport overhead, but never growing-prefix serialization.
  expect(serializedBytes).toBeLessThan(2 * Buffer.byteLength(stringify(messages), "utf8"));
  const requests = harness.commit.mock.calls.map(([, request]) => request);
  expect(requests.map((request) => request.messages.length)).toEqual([64, 64, 1]);
  expect(requests.flatMap((request) => request.messages)).toEqual(messages);
  expect(reads).toBe(messages.length);
  for (const request of requests) {
    expect(request.messages).not.toBe(messages);
  }
});

it("preserves exact frame-budget batch boundaries for UTF-8, escapes and images", async () => {
  const frame = (messages: WorkerTranscriptMessage[], seq: number, baseLeafId: string | null) =>
    ({
      type: "req",
      id: "00000000-0000-4000-8000-000000000000",
      method: "worker.transcript.commit",
      params: { runEpoch: Number.MAX_SAFE_INTEGER, seq, baseLeafId, messages },
    }) satisfies WorkerTranscriptCommitRequestFrame;
  const leaf = 'leaf-🦞-"\\';
  const fixtures: WorkerTranscriptMessage[][] = [];
  let seed = 81;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const alphabet = ["a", "é", "🦞", '"', "\\", "\n", "\u0000", "\ud800"];
  for (const character of alphabet) {
    fixtures.push(
      Array.from({ length: 70 }, (_, index) => {
        const text = character.repeat(100 + (random() % 1400));
        return index % 2 === 0
          ? userMessage(text)
          : {
              role: "custom",
              customType: "openclaw.system-update",
              content: text,
              display: false,
              timestamp: index,
              details: { kind: "runtime-context", turnScoped: true },
            };
      }),
    );
  }
  // The second message takes the first frame to exactly the control ceiling ±1 byte.
  const prefix = userMessage('🦞"\\\n'.repeat(100));
  const controlRoom =
    WORKER_PROTOCOL_MAX_PAYLOAD_BYTES -
    Buffer.byteLength(JSON.stringify(frame([prefix, userMessage("")], 9, null)), "utf8");
  for (const delta of [-1, 0, 1]) {
    fixtures.push([prefix, userMessage("x".repeat(controlRoom + delta)), userMessage("tail")]);
  }
  const imageMessage = (data: string): WorkerTranscriptMessage => ({
    role: "user",
    content: [{ type: "image", mimeType: "image/png", data }],
    timestamp: 1,
  });
  const imageRoom =
    WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES -
    Buffer.byteLength(JSON.stringify(frame([prefix, imageMessage("")], 9, null)), "utf8");
  for (const delta of [0, 1]) {
    fixtures.push([prefix, imageMessage("a".repeat(imageRoom + delta))]);
  }
  fixtures.push([imageMessage('é🦞"\\\n'.repeat(500)), userMessage("x".repeat(65_000))]);
  fixtures.push([userMessage("accepted"), userMessage("x".repeat(80_000))]);

  for (const messages of fixtures) {
    // Oracle: try whole frames, independently of incremental byte accounting.
    const expected: WorkerTranscriptCommitRequestFrame["params"][] = [];
    let offset = 0;
    let seq = 9;
    let baseLeafId: string | null = null;
    while (offset < messages.length) {
      let length = 0;
      for (
        let size = 1;
        size <= Math.min(WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES, messages.length - offset);
        size++
      ) {
        if (
          !transcriptBudget.isWorkerTranscriptFrameWithinBudget(
            frame(messages.slice(offset, offset + size), seq, baseLeafId),
          )
        ) {
          break;
        }
        length = size;
      }
      if (length === 0) {
        break;
      }
      expected.push(frame(messages.slice(offset, offset + length), seq, baseLeafId).params);
      offset += length;
      baseLeafId = leaf;
      seq++;
    }
    const harness = connectionHarness();
    harness.commit.mockResolvedValue(successResponse({ entryIds: ["entry"], newLeafId: leaf }));
    const client = new WorkerTranscriptCommitClient(harness.connection, {
      runEpoch: Number.MAX_SAFE_INTEGER,
      baseLeafId: null,
      initialSeq: 9,
    });
    if (offset < messages.length) {
      await expect(client.commit(messages)).rejects.toThrow("protocol payload limit");
    } else {
      await client.commit(messages);
    }
    expect(harness.commit.mock.calls.map(([, request]) => request)).toEqual(expected);
  }
});

it("does not send retired previews after connection readiness returns", async () => {
  const { client, ...harness } = liveHarness();
  const ready = createDeferred<WorkerHelloOk>();
  harness.waitForReady.mockReturnValue(ready.promise);
  harness.send.mockImplementation(async (_kind, request) =>
    request.lastAckedSeq > 0 ? resyncRequired() : successResponse({ ackedSeq: request.seq }),
  );
  onTestFinished(() => ready.resolve(HELLO));
  expect(Array.from({ length: 1_025 }, () => client.enqueuePreview("run-1", LIVE_EVENT))).toEqual(
    Array<boolean>(1_024).fill(true).concat(false),
  );
  const terminal = client.emitTerminal("run-1", TERMINAL_EVENT);
  ready.resolve(HELLO);

  await expect(terminal).resolves.toBeUndefined();
  expect(harness.send.mock.calls.map(([, r]) => [r.seq, r.lastAckedSeq, r.event])).toEqual([
    [1_025, 8, TERMINAL_EVENT],
    [1, 0, TERMINAL_EVENT],
  ]);
});

it("accepts out-of-order cumulative ACKs while a no-progress response has peers in flight", async () => {
  const { client, ...harness } = liveHarness();
  const firstResponse = createDeferred<LiveResponse>();
  const secondResponse = createDeferred<LiveResponse>();
  const terminalResponse = createDeferred<LiveResponse>();
  harness.send.mockImplementation(
    async (_kind, request) =>
      await ([firstResponse, secondResponse][request.seq - 1] ?? terminalResponse).promise,
  );

  client.enqueuePreview("run-1", LIVE_EVENT);
  client.enqueuePreview("run-1", LIVE_EVENT);
  const terminal = client.emitTerminal("run-1", TERMINAL_EVENT);
  await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(3));
  secondResponse.resolve(successResponse({ ackedSeq: 0 }));
  await Promise.resolve();
  expect(harness.send).toHaveBeenCalledTimes(3);
  firstResponse.resolve(successResponse({ ackedSeq: 2 }));
  terminalResponse.resolve(successResponse({ ackedSeq: 3 }));

  await expect(terminal).resolves.toBeUndefined();
});

it.each(["concurrent", "earlier"])("recovers finishing after %s rejection", async (timing) => {
  const { client, ...harness } = liveHarness();
  const preview = createDeferred<LiveResponse>();
  const firstTerminal = createDeferred<LiveResponse>();
  harness.send.mockImplementationOnce(async () => await preview.promise);
  if (timing === "concurrent") {
    harness.send.mockImplementationOnce(async () => await firstTerminal.promise);
  }
  harness.send
    .mockImplementationOnce(async (_kind, request) =>
      request.lastAckedSeq > 0 ? resyncRequired() : successResponse({ ackedSeq: 0 }),
    )
    .mockResolvedValueOnce(successResponse({ ackedSeq: 1 }));

  client.enqueuePreview("run-1", LIVE_EVENT);
  let finishing: Promise<void>;
  if (timing === "concurrent") {
    finishing = client.emitTerminal("run-1", TERMINAL_EVENT);
    await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(2));
    preview.resolve(PREVIEW_REJECTED);
    firstTerminal.resolve(successResponse({ ackedSeq: 0 }));
  } else {
    preview.resolve(PREVIEW_REJECTED);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(harness.send).toHaveBeenCalledOnce();
    client.enqueuePreview("run-1", LIVE_EVENT);
    expect(harness.send).toHaveBeenCalledOnce();
    finishing = client.emitTerminal("run-1", TERMINAL_EVENT);
  }
  await expect(finishing).resolves.toBeUndefined();
  const retryAcks = timing === "concurrent" ? [0, 2] : [1];
  expect(harness.send.mock.calls.map((call) => call[1])).toEqual([
    expect.objectContaining({ seq: 1, lastAckedSeq: 0, event: LIVE_EVENT }),
    ...retryAcks.map((lastAckedSeq) => expect.objectContaining({ seq: 2, lastAckedSeq })),
    expect.objectContaining({ seq: 1, lastAckedSeq: 0 }),
  ]);
});

it("recovers terminal delivery after a repeated no-progress preview resync", async () => {
  const { client, ...harness } = liveHarness({ initialAckedSeq: 5 });
  const resyncResponse = resyncRequired();
  harness.send
    .mockResolvedValueOnce(resyncResponse)
    .mockResolvedValueOnce(resyncResponse)
    .mockImplementationOnce(async (_kind, request) =>
      request.lastAckedSeq > 0 ? resyncResponse : successResponse({ ackedSeq: 0 }),
    )
    .mockResolvedValueOnce(successResponse({ ackedSeq: 1 }));

  client.enqueuePreview("run-1", LIVE_EVENT);
  await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(2));
  await expect(client.emitTerminal("run-1", TERMINAL_EVENT)).resolves.toBeUndefined();
  expect(harness.send).toHaveBeenCalledTimes(4);
});

it("rejects terminal delivery when a preview receives an inconsistent resync cursor", async () => {
  const { client, ...harness } = liveHarness();
  const previewResponse = createDeferred<LiveResponse>();
  const terminalResponse = createDeferred<LiveResponse>();
  harness.send.mockImplementation(async (_kind, request) =>
    request.event.kind === "lifecycle" ? terminalResponse.promise : previewResponse.promise,
  );

  client.enqueuePreview("run-1", LIVE_EVENT);
  const terminal = client.emitTerminal("run-1", TERMINAL_EVENT);
  await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(2));
  previewResponse.resolve(resyncRequired(0, 2));

  await expect(terminal).rejects.toThrow("worker live-event resync cursor is inconsistent");
  terminalResponse.resolve(successResponse({ ackedSeq: 2 }));
});

it("drops previews and rejects terminal delivery after stop without rescheduling", async () => {
  const { client, ...harness } = liveHarness();
  harness.waitForReady.mockRejectedValue(new WorkerConnectionStoppedError());
  harness.emitTerminalError({ kind: "stopped" }, new WorkerConnectionStoppedError());

  client.enqueuePreview("run-1", LIVE_EVENT);
  await expect(client.emitTerminal("run-1", TERMINAL_EVENT)).rejects.toBeInstanceOf(
    WorkerConnectionStoppedError,
  );
  expect(harness.waitForReady).toHaveBeenCalledOnce();
  expect(harness.send).not.toHaveBeenCalled();
});

it("rejects the terminal barrier when the worker is fenced", async () => {
  const { client, ...harness } = liveHarness();
  harness.send.mockImplementation(async () => await new Promise<never>(() => {}));

  client.enqueuePreview("run-1", LIVE_EVENT);
  const terminal = client.emitTerminal("run-1", TERMINAL_EVENT);
  await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(2));
  harness.emitTerminalError(
    { kind: "fenced", reason: "owner-epoch-mismatch" },
    new WorkerFencedError("owner-epoch-mismatch"),
  );

  await expect(terminal).rejects.toEqual(new WorkerFencedError("owner-epoch-mismatch"));
});

it("reports stream gaps but accepts later events and the terminal outcome", async () => {
  const harness = connectionHarness();
  harness.start.mockResolvedValueOnce(successResponse({ status: "accepted" as const }));
  const client = new WorkerInferenceProxyClient(harness.connection);
  const deliveries: string[] = [];
  const outcome = client.start(INFERENCE_REQUEST, {
    onEvent: () => deliveries.push("event"),
    onStreamGap: () => deliveries.push("gap"),
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());
  expect(harness.start.mock.calls[0]?.[1]).toEqual(INFERENCE_REQUEST);
  harness.emitInferenceEvent(1, { type: "text_start", contentIndex: 0 });
  harness.emitInferenceEvent(3, { type: "text_delta", contentIndex: 0, delta: "continued" });
  harness.emitInferenceTerminal(4, TERMINAL_OUTCOME);

  await expect(outcome).resolves.toEqual(TERMINAL_OUTCOME);
  expect(deliveries).toEqual(["event", "gap", "event"]);
  client.dispose();
});

it("reattaches an active turn and consumes its replayed terminal", async () => {
  const harness = connectionHarness();
  harness.start.mockResolvedValueOnce(successResponse({ status: "accepted" as const }));
  harness.start.mockImplementationOnce(async (_kind, _params, beforeResolve) => {
    const response = successResponse({ status: "replayed" as const });
    beforeResolve?.(response);
    harness.emitInferenceTerminal(1, TERMINAL_OUTCOME);
    return response;
  });
  const client = new WorkerInferenceProxyClient(harness.connection);
  const onStreamGap = vi.fn();

  const outcome = client.start(INFERENCE_REQUEST, { onStreamGap });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());
  harness.emitInferenceEvent(1, { type: "text_start", contentIndex: 0 });
  harness.emitReady();
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(2));

  await expect(outcome).resolves.toEqual(TERMINAL_OUTCOME);
  expect(harness.start.mock.calls[1]?.[1]).toEqual(harness.start.mock.calls[0]?.[1]);
  expect(onStreamGap).not.toHaveBeenCalled();
  client.dispose();
});
