import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { WORKER_PROTOCOL_MAX_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
  type WorkerInferenceContext,
  type WorkerInferenceEventParams,
  type WorkerInferenceModelRef,
  type WorkerInferenceStartParams,
  type WorkerInferenceTerminalOutcome,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import type { Usage, AssistantMessage } from "../llm/types.js";
import { testWorkerDescriptor } from "../node-host/node-worker-supervisor.test-support.js";
import { createWorkerInferenceStreamAdapter } from "./inference-stream.runtime.js";
import { buildWorkerConnectParams } from "./launch-descriptor.js";
import { createWorkerImageHistory } from "./replay-images.test-support.js";
import { fitWorkerReplayImages } from "./replay-message-window.js";
import {
  isWorkerTranscriptMessageFrameSafe,
  WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE,
} from "./transcript-message.js";
import { createWorkerConnection } from "./worker-connection.js";
import { WorkerInferenceProxyClient } from "./worker-rpc-inference-client.js";

const modelRef: WorkerInferenceModelRef = { provider: "test", model: "test-model" };
const usage: Usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const clients: WorkerInferenceProxyClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.dispose();
  }
});

function createClient() {
  const client = new WorkerInferenceProxyClient(
    createWorkerConnection({
      endpoint: { kind: "unix", socketPath: "/tmp/worker-inference-size-test.sock" },
      connectParams: buildWorkerConnectParams(testWorkerDescriptor("/tmp/worker-inference")),
    }),
  );
  clients.push(client);
  return client;
}

function done(content: AssistantMessage["content"], stopReason: "stop" | "toolUse" = "stop") {
  return {
    type: "done",
    message: makeAgentAssistantMessage({
      content,
      stopReason,
      usage,
      timestamp: 1,
      api: "openai-responses",
      provider: modelRef.provider,
      model: modelRef.model,
    }),
  } satisfies WorkerInferenceTerminalOutcome;
}

function createAdapterFixture(
  computerContextEpoch?: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  },
  events: WorkerInferenceEventParams["event"][] = [],
  gap = false,
) {
  const client = createClient();
  const start = vi.spyOn(client, "start").mockImplementation(async (request, handlers) => {
    if (gap) {
      handlers?.onStreamGap?.({ expectedSeq: 1, receivedSeq: 2 });
    }
    events.forEach((event, index) =>
      handlers?.onEvent?.({ ...request, seq: index + (gap ? 2 : 1), event }),
    );
    return done([{ type: "text", text: "Done." }]);
  });
  const options = {
    client,
    sessionId: "session-1",
    runEpoch: 1,
    runId: "run-1",
    turnId: "turn-1",
    modelRef,
    computerContextEpoch,
  };
  const stream = createWorkerInferenceStreamAdapter(options);
  return {
    start,
    stream: (context: WorkerInferenceContext = { messages: [] }) =>
      stream({ modelRef, context, options: {} }),
  };
}

function inferenceFrameBytes(request: WorkerInferenceStartParams): number {
  return Buffer.byteLength(
    JSON.stringify({
      type: "req",
      id: "00000000-0000-4000-8000-000000000000",
      method: "worker.inference.start",
      params: request,
    }),
    "utf8",
  );
}

function inferenceRequest(context: WorkerInferenceContext): WorkerInferenceStartParams {
  return {
    runEpoch: 1,
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1:1",
    modelRef,
    context,
    options: {},
  };
}

it("keeps text and thinking content and signatures in their own stream blocks", async () => {
  const fixture = createAdapterFixture(undefined, [
    { type: "text_start", contentIndex: 0, contentSignature: "initial-text" },
    { type: "text_delta", contentIndex: 0, delta: "hello" },
    { type: "text_end", contentIndex: 0, contentSignature: "final-text" },
    { type: "thinking_start", contentIndex: 1 },
    { type: "thinking_delta", contentIndex: 1, delta: "reasoning" },
    { type: "thinking_end", contentIndex: 1, contentSignature: "final-thinking" },
  ]);
  const ended = [];
  for await (const event of fixture.stream()) {
    if (event.type === "text_end" || event.type === "thinking_end") {
      ended.push({
        type: event.type,
        content: event.content,
        block: event.partial.content[event.contentIndex],
      });
    }
  }
  expect(ended).toEqual([
    {
      type: "text_end",
      content: "hello",
      block: { type: "text", text: "hello", textSignature: "final-text" },
    },
    {
      type: "thinking_end",
      content: "reasoning",
      block: { type: "thinking", thinking: "reasoning", thinkingSignature: "final-thinking" },
    },
  ]);
});

it.each([62_500, null])(
  "retains provider retry floor %s when a worker error becomes an assistant failure",
  async (retryAfterMs) => {
    const fixture = createAdapterFixture();
    fixture.start.mockResolvedValue({
      type: "error",
      reason: "provider-error",
      message: "429: rate_limit_exceeded",
      retryAfterMs,
    });
    const result = await fixture.stream().result();
    expect(result).toMatchObject({ stopReason: "error", retryAfterMs });
    expect(isWorkerTranscriptMessageFrameSafe(result)).toBe(true);
  },
);

it.each([
  ["text", "end", { type: "text_end", contentIndex: 0 }],
  ["thinking", "delta", { type: "thinking_delta", contentIndex: 0, delta: "wrong block" }],
] as const)(
  "rejects %s %s when its content block has the wrong kind",
  async (kind, suffix, event) => {
    const fixture = createAdapterFixture(undefined, [
      { type: kind === "text" ? "thinking_start" : "text_start", contentIndex: 0 },
      event,
    ]);
    await expect(fixture.stream().result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: `worker inference ${kind} ${suffix} has no active ${kind} block`,
    });
  },
);

it("tolerates missing text and thinking blocks after a stream gap", async () => {
  const fixture = createAdapterFixture(
    undefined,
    [
      { type: "text_delta", contentIndex: 0, delta: "missing" },
      { type: "text_end", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 1, delta: "missing" },
      { type: "thinking_end", contentIndex: 1 },
    ],
    true,
  );
  const types = [];
  for await (const event of fixture.stream()) {
    types.push(event.type);
  }
  expect(types).toEqual(["done"]);
});

it("preserves the provider failure and usage after an oversized partial response", async () => {
  const fixture = createAdapterFixture();
  fixture.start.mockImplementation(async (request, handlers) => {
    const events: WorkerInferenceEventParams["event"][] = [
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "x".repeat(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) },
    ];
    events.forEach((event, index) => handlers?.onEvent?.({ ...request, seq: index + 1, event }));
    return { type: "error", reason: "provider-error", message: "429: rate limit exceeded", usage };
  });

  const result = await fixture.stream().result();
  expect(result).toMatchObject({
    stopReason: "error",
    errorMessage: "429: rate limit exceeded",
    usage,
    content: [],
  });
  expect(isWorkerTranscriptMessageFrameSafe(result)).toBe(true);
});

it.each([false, true])(
  "bounds screenshot serialization work while preserving the fitted request (oversized: %s)",
  async (oversized) => {
    const messages = createWorkerImageHistory();
    for (const message of messages) {
      if (message.role === "assistant") {
        continue;
      }
      for (const part of message.content) {
        if (part.type === "image") {
          part.data = "A".repeat(oversized ? 8 * 1024 * 1024 : 8);
        }
      }
    }
    const context = { messages, systemPrompt: 'Inspect café 😀 with quotes " and a slash \\.' };
    const request = inferenceRequest(context);
    const originalBytes = inferenceFrameBytes(request);
    const expected = fitWorkerReplayImages(messages, (candidate) =>
      inferenceFrameBytes({ ...request, context: { ...context, messages: candidate } }),
    );
    const originalContents = messages.map((message) => message.content);
    const fixture = createAdapterFixture();
    const stringify = JSON.stringify;
    let serializedBytes = 0;
    const frameMessageCounts: number[] = [];
    const serialization = vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
      const encoded = stringify(value, ...args);
      if (encoded !== undefined) {
        serializedBytes += Buffer.byteLength(encoded, "utf8");
      }
      if (isRecord(value) && value.method === "worker.inference.start") {
        frameMessageCounts.push(
          (value.params as WorkerInferenceStartParams).context.messages.length,
        );
      }
      return encoded;
    });
    try {
      await fixture.stream(context).result();
    } finally {
      serialization.mockRestore();
    }
    const [sent] = expectDefined(fixture.start.mock.calls[0], "inference start");
    expect(sent.context.messages).toEqual(expected);
    expect(inferenceFrameBytes(sent)).toBeLessThanOrEqual(
      WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
    );
    for (const [index, message] of messages.entries()) {
      expect(message.content).toBe(originalContents[index]);
    }
    if (oversized) {
      // Several removals must not re-encode all stable screenshots for every candidate.
      expect(serializedBytes).toBeLessThan(originalBytes * 2);
    } else {
      expect(frameMessageCounts).toEqual([messages.length]);
    }
  },
);

it("fits observed screenshot history without changing durable messages", async () => {
  const messages = createWorkerImageHistory(true);
  const originalContents = messages.map((message) => message.content);
  const current = messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === "image-0",
  );
  const image = current?.content.find((part) => part.type === "image");
  if (image?.type !== "image") {
    throw new Error("Missing current computer image");
  }
  const computerContextEpoch = {
    value: 0,
    frameToolCallId: "image-0",
    frameImageIdentity: createHash("sha256")
      .update(JSON.stringify([image.mimeType, image.data]))
      .digest("hex"),
  };
  const fixture = createAdapterFixture(computerContextEpoch);
  await fixture.stream({ messages }).result();
  const [request] = expectDefined(fixture.start.mock.calls[0], "inference start");
  const bytes = inferenceFrameBytes(request);
  expect(bytes).toBeLessThanOrEqual(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES);
  expect(request?.context.messages).toHaveLength(messages.length);
  expect(request?.context.messages[2]).toEqual(current);
  expect(request?.context.messages.at(-1)).toEqual(messages.at(-1));
  for (const [index, message] of messages.entries()) {
    expect(message.content).toBe(originalContents[index]);
    if (message.role === "assistant") {
      expect(request?.context.messages[index]).toEqual(message);
    } else {
      for (const part of message.content.filter((block) => block.type === "text")) {
        expect(request?.context.messages[index]?.content).toContainEqual(part);
      }
    }
  }
  expect(computerContextEpoch.value).toBe(0);
});

it("invalidates computer coordinates when the final model context lacks their screenshot", async () => {
  const computerContextEpoch = {
    value: 0,
    frameToolCallId: "missing",
    frameImageIdentity: "missing",
  };
  const fixture = createAdapterFixture(computerContextEpoch);
  await fixture.stream().result();
  expect(computerContextEpoch.value).toBe(1);
  expect(computerContextEpoch).not.toHaveProperty("frameToolCallId");
});

it("refuses oversized unprocessed images without discarding them", async () => {
  const content = createWorkerImageHistory().flatMap((message) =>
    message.role === "toolResult" ? message.content : [],
  );
  const context: WorkerInferenceContext = { messages: [{ role: "user", content, timestamp: 1 }] };
  const fixture = createAdapterFixture();
  const result = await fixture.stream(context).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toMatch(/(image|context).*(limit|budget)/i);
  expect(fixture.start).not.toHaveBeenCalled();
  expect(context.messages[0]?.content).toBe(content);
  expect(content.filter((part) => part.type === "image")).toHaveLength(7);
});

it("preserves opaque replay and its image history when the mandatory replay cannot fit", async () => {
  const messages = createWorkerImageHistory();
  const owner = messages[1];
  if (owner?.role !== "assistant") {
    throw new Error("Missing replay owner");
  }
  owner.providerReplay = {
    v: 1,
    type: "openai-responses-compaction",
    data: "opaque-checkpoint",
    provider: "test",
    api: "openai-responses",
    model: "test-model",
  };
  const before = JSON.stringify(messages);
  const fixture = createAdapterFixture();
  const result = await fixture.stream({ messages }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain(WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE);
  expect(fixture.start).not.toHaveBeenCalled();
  expect(JSON.stringify(messages)).toBe(before);
});

it("delays worker tool argument previews while preserving exact terminal arguments", async () => {
  const initialContent = "a".repeat(128);
  const checkpointContent = "b".repeat(400);
  const deltas = [`{"content":"${initialContent}`, checkpointContent, `","terminal":"exact"}`];
  const terminalArguments = {
    content: initialContent + checkpointContent,
    terminal: "exact",
  };
  const start: WorkerInferenceProxyClient["start"] = async (request, handlers) => {
    const identity = {
      runEpoch: request.runEpoch,
      sessionId: request.sessionId,
      runId: request.runId,
      turnId: request.turnId,
    };
    const streamEvents: WorkerInferenceEventParams["event"][] = [
      { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "write" },
      ...deltas.map((delta) => ({ type: "toolcall_delta" as const, contentIndex: 0, delta })),
      { type: "toolcall_end", contentIndex: 0 },
    ];
    for (const [index, event] of streamEvents.entries()) {
      handlers?.onEvent?.({ ...identity, seq: index + 1, event });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    return done(
      [{ type: "toolCall", id: "call-1", name: "write", arguments: terminalArguments }],
      "toolUse",
    );
  };
  const fixture = createAdapterFixture();
  fixture.start.mockImplementation(start);
  const stream = fixture.stream();
  const argumentSnapshots: Array<Record<string, unknown>> = [];
  let endArguments: Record<string, unknown> | undefined;
  for await (const event of stream) {
    if (event.type === "toolcall_delta") {
      const content = event.partial.content[event.contentIndex];
      if (content?.type === "toolCall") {
        argumentSnapshots.push(structuredClone(content.arguments));
      }
    } else if (event.type === "toolcall_end") {
      endArguments = structuredClone(event.toolCall.arguments);
    }
  }

  const checkpointPreview = { content: initialContent + checkpointContent };
  expect(argumentSnapshots).toEqual([{}, checkpointPreview, checkpointPreview]);
  expect(endArguments).toEqual(terminalArguments);
  await expect(stream.result()).resolves.toMatchObject({
    content: [{ type: "toolCall", arguments: terminalArguments }],
  });
});
