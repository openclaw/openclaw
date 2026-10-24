import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import type { NormalizedUsage } from "../agents/usage.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  collectSseEventTypes,
  findSseEvent,
  parseSseData,
  parseSseDataLines,
  parseSseEvents,
} from "./http-stream.test-support.js";
import type { ResponseResource } from "./open-responses.schema.js";
import {
  agentCommandMock,
  getGatewayTestPort,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
} from "./test-helpers.js";

let server: Awaited<ReturnType<typeof startGatewayServerWithRetries>>["server"];
let port: number;
const agentIdentity = { sessionId: "usage-session", provider: "ollama", model: "local-model" };
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    ({ port, server } = await startGatewayServerWithRetries({
      port: await getGatewayTestPort(),
      opts: {
        host: "127.0.0.1",
        auth: { mode: "none" },
        controlUiEnabled: false,
        openAiChatCompletionsEnabled: true,
        openResponsesEnabled: true,
      },
    }));
  },
  cleanup: async () => server?.close({ reason: "HTTP usage suite done" }),
});

function mockUsageResult(usage: NormalizedUsage, lastCallUsage?: NormalizedUsage) {
  agentCommandMock.mockClear();
  agentCommandMock.mockImplementationOnce(async (opts: unknown) => {
    const runId = (opts as { runId: string }).runId;
    emitAgentEvent({ runId, stream: "assistant", data: { delta: "Partial answer" } });
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
    return {
      payloads: [{ text: "Partial answer", mediaUrl: null }],
      meta: { durationMs: 0, agentMeta: { ...agentIdentity, usage, lastCallUsage } },
    };
  });
}

async function post(endpoint: "chat/completions" | "responses", body: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openclaw-scopes": "operator.write" },
    body: JSON.stringify({
      model: "openclaw",
      ...(endpoint === "responses"
        ? { input: "hi" }
        : { messages: [{ role: "user", content: "hi" }], stream_options: { include_usage: true } }),
      ...body,
    }),
  });
  expect(res.status).toBe(200);
  return res;
}

function chunksFrom(data: string[]) {
  return data
    .filter((entry) => entry !== "[DONE]")
    .map((entry) => JSON.parse(entry) as OpenAI.ChatCompletionChunk);
}
function expectDone(data: string[]) {
  expect(data.filter((entry) => entry === "[DONE]")).toHaveLength(1);
  expect(data.at(-1)).toBe("[DONE]");
}
const earlierUsage = { input: 11, output: 7, total: 18 };
const unavailableUsage = { ...earlierUsage, usageReport: { state: "unavailable" as const } };

describe("OpenAI-compatible HTTP usage", () => {
  it.each([
    { endpoint: "chat/completions", stream: false, failed: false },
    { endpoint: "chat/completions", stream: true, failed: false },
    { endpoint: "responses", stream: false, failed: false },
    { endpoint: "responses", stream: true, failed: false },
    { endpoint: "responses", stream: true, failed: true },
  ] as const)(
    "omits usage without losing the $endpoint response (stream=$stream, failed=$failed)",
    async ({ endpoint, stream, failed }) => {
      if (failed) {
        agentCommandMock.mockClear();
        agentCommandMock.mockRejectedValueOnce(new Error("Synthetic run failure"));
      } else {
        mockUsageResult(unavailableUsage, earlierUsage);
      }
      const res = await post(endpoint, { stream });
      const text = await res.text();
      if (endpoint === "chat/completions") {
        if (!stream) {
          const response = JSON.parse(text) as OpenAI.ChatCompletion;
          expect(response.choices[0]?.message.content).toBe("Partial answer");
          expect(response).not.toHaveProperty("usage");
        } else {
          const data = parseSseDataLines(text);
          const chunks = chunksFrom(data);
          const choices = chunks.flatMap((chunk) => chunk.choices);
          expect(choices.map((choice) => choice.delta.content ?? "").join("")).toBe(
            "Partial answer",
          );
          expect(choices.map((choice) => choice.finish_reason).filter(Boolean)).toEqual(["stop"]);
          expect(chunks.every((chunk) => !("usage" in chunk))).toBe(true);
          expectDone(data);
        }
        return;
      }
      const status = failed ? "failed" : "completed";
      const events = stream ? parseSseEvents(text) : [];
      const response = stream
        ? (
            parseSseData(findSseEvent(events, `response.${status}`)) as {
              response: ResponseResource;
            }
          ).response
        : (JSON.parse(text) as ResponseResource);
      expect(response.status).toBe(status);
      expect(response).not.toHaveProperty("usage");
      if (stream) {
        expectDone(events.map((event) => event.data));
        if (!failed) {
          expect(
            collectSseEventTypes(events).filter((type) =>
              ["response.completed", "response.incomplete", "response.failed"].includes(type),
            ),
          ).toEqual(["response.completed"]);
        }
      }
      if (failed) {
        return;
      }
      expect(response.output).toMatchObject([
        { type: "message", content: [{ type: "output_text", text: "Partial answer" }] },
      ]);
      const sessionKey = (agentCommandMock.mock.calls[0]?.[0] as { sessionKey: string } | undefined)
        ?.sessionKey;
      expect(sessionKey).toBeTypeOf("string");
      agentCommandMock.mockResolvedValueOnce({
        payloads: [{ text: "Continued", mediaUrl: null }],
        meta: { durationMs: 0 },
      });
      await (await post("responses", { previous_response_id: response.id })).text();
      expect(agentCommandMock.mock.calls[1]?.[0]).toMatchObject({ sessionKey });
    },
  );

  it.each([
    {
      name: "aggregate",
      usage: { input: 12, output: 5, cacheRead: 3, cacheWrite: 0, total: 20 },
      lastCallUsage: undefined,
      expected: {
        prompt_tokens: 15,
        completion_tokens: 5,
        total_tokens: 20,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    },
    {
      name: "fallback for legacy zero aggregate",
      usage: { input: 0, output: 0, total: 0 },
      lastCallUsage: { input: 55, output: 7, total: 62 },
      expected: { prompt_tokens: 55, completion_tokens: 7, total_tokens: 62 },
    },
    {
      name: "measured zero over earlier call",
      usage: { input: 0, output: 0, total: 0, usageReport: { state: "available" as const } },
      lastCallUsage: { input: 55, output: 7, total: 62 },
      expected: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  ])(
    "reports $name usage in the final stream chunk",
    async ({ usage, lastCallUsage, expected }) => {
      mockUsageResult(usage, lastCallUsage);
      const res = await post("chat/completions", { stream: true });
      const data = parseSseDataLines(await res.text());
      expect(data.at(-1)).toBe("[DONE]");
      const usageChunk = chunksFrom(data).find((chunk) => "usage" in chunk);
      expect(usageChunk?.usage).toEqual(expected);
      expect(usageChunk?.choices).toStrictEqual([]);
    },
  );
});
