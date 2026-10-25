import assert from "node:assert/strict";
import { createServer } from "node:http";
import { crc32 } from "node:zlib";
import { convertToLlm, runAgentLoop } from "openclaw/plugin-sdk/agent-core";
import { afterEach, expect, it, vi } from "vitest";
import bedrockPlugin from "../../extensions/amazon-bedrock/index.js";
import { createSubscribedSessionHarness } from "../../src/agents/embedded-agent-subscribe.e2e-harness.js";
import { makeProviderModelFixture } from "../../src/agents/test-helpers/provider-model-fixture.js";
import { onAgentEventForRun } from "../../src/infra/agent-events.js";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";
import { closeHttpServer, listenLoopback } from "../helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../helpers/promise.js";

const model = makeProviderModelFixture({
  id: "amazon.nova-micro-v1:0",
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  reasoning: true,
});

const reasoningDelta = (reasoningContent: { text: string } | { redactedContent: string }) => ({
  contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent } },
});

function bedrockEvent(type: string, payload: unknown): Buffer {
  // Amazon event-stream frames carry string headers and CRCs over the prelude
  // and full message. Exercise the SDK decoder instead of mocking its output.
  const headers = Buffer.concat(
    Object.entries({
      ":message-type": "event",
      ":event-type": type,
      ":content-type": "application/json",
    }).map(([name, value]) =>
      Buffer.concat([
        Buffer.from([name.length]),
        Buffer.from(name),
        Buffer.from([7, value.length >>> 8, value.length & 0xff]),
        Buffer.from(value),
      ]),
    ),
  );
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(16 + headers.length + body.length);
  frame.writeUInt32BE(frame.length, 0);
  frame.writeUInt32BE(headers.length, 4);
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  headers.copy(frame, 12);
  body.copy(frame, 12 + headers.length);
  frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
  return frame;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.for(["incremental", "buffered"] as const)(
  "keeps Bedrock's redacted snapshot with %s consumption",
  async (consumption, { signal }) => {
    const firstDeltaConsumed = createDeferred();
    async function* responses() {
      yield { messageStart: { role: "assistant" } };
      yield reasoningDelta({ text: "before" });
      if (consumption === "incremental") {
        await firstDeltaConsumed.promise;
      }
      yield reasoningDelta({ redactedContent: "AQID" });
      yield reasoningDelta({ text: " after" });
      yield { contentBlockStop: { contentBlockIndex: 0 } };
      yield { messageStop: { stopReason: "end_turn" } };
    }
    vi.stubEnv("AWS_BEDROCK_SKIP_AUTH", "1");
    vi.stubEnv("AWS_BEDROCK_FORCE_HTTP1", "1");
    const provider = await registerSingleProviderPlugin(bedrockPlugin);
    const streamFn = provider.createStreamFn?.({
      provider: model.provider,
      modelId: model.id,
      model,
    });
    assert(streamFn, "Bedrock stream registration missing");
    const runId = `bedrock-native-reasoning-replacement-${consumption}`;
    const { emit, subscription } = createSubscribedSessionHarness({ runId });
    const thinking: Array<{ text: unknown; delta: unknown }> = [];
    const unsubscribe = onAgentEventForRun(runId, (event) => {
      if (event.stream === "thinking") {
        thinking.push({ text: event.data.text, delta: event.data.delta });
      }
    });
    let requestCount = 0;
    const server = createServer((request, response) => {
      requestCount++;
      request.resume();
      response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
      void (async () => {
        for await (const event of responses()) {
          const [type, payload] = Object.entries(event)[0]!;
          response.write(bedrockEvent(type, payload));
        }
        response.end();
      })().catch((error: unknown) =>
        response.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    });
    try {
      const fixtureModel = { ...model, baseUrl: await listenLoopback(server) };
      await runAgentLoop(
        [{ role: "user", content: "Explain the fixture.", timestamp: 0 }],
        { systemPrompt: "", messages: [] },
        { model: fixtureModel, convertToLlm },
        async (event) => {
          emit(event);
          await subscription.waitForPendingEvents();
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "thinking_delta"
          ) {
            firstDeltaConsumed.resolve();
          }
        },
        signal,
        async (streamModel, context, options) => {
          const response = await streamFn(streamModel, context, options);
          if (consumption === "buffered") {
            // Queued events retain mutable partials. Redaction must stay
            // authoritative even when no earlier event has been consumed.
            await response.result();
          }
          return response;
        },
      );
      expect(requestCount).toBe(1);
      expect(thinking).toEqual([
        ...(consumption === "incremental" ? [{ text: "before", delta: "before" }] : []),
        { text: "[Reasoning redacted] after", delta: "[Reasoning redacted] after" },
      ]);
    } finally {
      firstDeltaConsumed.resolve();
      unsubscribe();
      subscription.unsubscribe();
      await closeHttpServer(server);
    }
  },
);
