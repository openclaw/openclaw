import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import type { AgentCommandDeliveryResult } from "../agents/command/delivery-result.js";
import type { NormalizedUsage } from "../agents/usage.js";
import { recordAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  collectSseEventTypes,
  findSseEvent,
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

async function post(
  endpoint: "chat/completions" | "responses",
  body: Record<string, unknown>,
  expectedStatus = 200,
) {
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
  expect(res.status).toBe(expectedStatus);
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
function chatText(choices: OpenAI.ChatCompletionChunk.Choice[]) {
  return choices.map((choice) => choice.delta.content ?? "").join("");
}
function responseFrom(text: string, stream: boolean, status: string): ResponseResource {
  return stream
    ? (
        JSON.parse(findSseEvent(parseSseEvents(text), `response.${status}`).data) as {
          response: ResponseResource;
        }
      ).response
    : (JSON.parse(text) as ResponseResource);
}
function terminalTypes(events: ReturnType<typeof parseSseEvents>) {
  return collectSseEventTypes(events).filter((type) =>
    ["response.completed", "response.incomplete", "response.failed"].includes(type),
  );
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
          expect(chatText(choices)).toBe("Partial answer");
          expect(choices.map((choice) => choice.finish_reason).filter(Boolean)).toEqual(["stop"]);
          expect(chunks.every((chunk) => !("usage" in chunk))).toBe(true);
          expectDone(data);
        }
        return;
      }
      const status = failed ? "failed" : "completed";
      const events = stream ? parseSseEvents(text) : [];
      const response = responseFrom(text, stream, status);
      expect(response.status).toBe(status);
      expect(response).not.toHaveProperty("usage");
      if (stream) {
        expectDone(events.map((event) => event.data));
        if (!failed) {
          expect(terminalTypes(events)).toEqual(["response.completed"]);
        }
      }
      if (failed) {
        return;
      }
      expect(response.output).toMatchObject([
        { type: "message", content: [{ type: "output_text", text: "Partial answer" }] },
      ]);
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

const summary = "Recovered summary of the work so far.";
const notice = "Warning: the turn reached its output limit before completion (#178525).";
const finalText = `${summary}\n\n${notice}`;
const surfaces = [
  { endpoint: "chat/completions", stream: false, requiredTool: false, divergent: false },
  { endpoint: "chat/completions", stream: true, requiredTool: false, divergent: false },
  { endpoint: "responses", stream: false, requiredTool: false, divergent: false },
  { endpoint: "responses", stream: true, requiredTool: false, divergent: false },
  { endpoint: "chat/completions", stream: true, requiredTool: true, divergent: false },
  { endpoint: "responses", stream: true, requiredTool: true, divergent: false },
  { endpoint: "chat/completions", stream: true, requiredTool: false, divergent: true },
  { endpoint: "responses", stream: true, requiredTool: false, divergent: true },
] as const;

describe("OpenAI-compatible recovered incomplete turns", () => {
  it.each(surfaces)(
    "delivers recovery text with a failure on $endpoint (stream=$stream, requiredTool=$requiredTool, divergent=$divergent)",
    async ({ endpoint, stream, requiredTool, divergent }) => {
      const initialText = divergent ? "I will check the first file." : summary;
      const expectedStreamText = requiredTool ? "" : divergent ? initialText : finalText;
      agentCommandMock.mockClear();
      agentCommandMock.mockImplementationOnce(async (opts: unknown) => {
        const { runId } = opts as { runId: string };
        emitAgentEvent({ runId, stream: "assistant", data: { delta: initialText } });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "error", error: "Output limit reached" },
        });
        return recordAgentRunTerminalOutcome(
          {
            payloads: [summary, notice].map((text) => ({ text, mediaUrl: null })),
            meta: {
              durationMs: 0,
              stopReason: "length",
              error: { kind: "incomplete_turn", message: notice },
            },
          } satisfies AgentCommandDeliveryResult,
          "failed",
        );
      });
      const tool = { name: "required_tool", description: "Complete the requested action" };
      const body = requiredTool
        ? {
            stream,
            tools: [
              endpoint === "responses"
                ? { type: "function", ...tool }
                : { type: "function", function: tool },
            ],
            tool_choice: "required",
          }
        : { stream };
      const res = await post(endpoint, body, stream ? 200 : 500);
      const text = await res.text();
      if (endpoint === "chat/completions") {
        const chunks = stream ? chunksFrom(parseSseDataLines(text)) : [];
        expect(stream ? chunks.at(-1) : JSON.parse(text)).toEqual({
          error: { message: finalText, type: "api_error", code: "incomplete_turn" },
        });
        if (stream) {
          const choices = chunks.flatMap((chunk) => chunk.choices ?? []);
          expect(chatText(choices)).toBe(expectedStreamText);
          expect(choices.every((choice) => choice.finish_reason === null)).toBe(true);
        }
        return;
      }
      const events = stream ? parseSseEvents(text) : [];
      const response = responseFrom(text, stream, "failed");
      expect(response).toMatchObject({
        status: "failed",
        error: { code: "incomplete_turn" },
        output: [
          {
            type: "message",
            status: "incomplete",
            content: [{ type: "output_text", text: finalText }],
          },
        ],
      });
      if (stream) {
        expect(
          events
            .filter((event) => event.event === "response.output_text.delta")
            .map((event) => JSON.parse(event.data).delta)
            .join(""),
        ).toBe(expectedStreamText);
        expect(terminalTypes(events)).toEqual(["response.failed"]);
      }
    },
  );
});
