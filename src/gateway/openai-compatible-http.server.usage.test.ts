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
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    const started = await startGatewayServerWithRetries({
      port: await getGatewayTestPort(),
      opts: {
        host: "127.0.0.1",
        auth: { mode: "none" },
        controlUiEnabled: false,
        openAiChatCompletionsEnabled: true,
        openResponsesEnabled: true,
      },
    });
    port = started.port;
    server = started.server;
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
      meta: {
        durationMs: 0,
        agentMeta: {
          sessionId: "usage-session",
          provider: "ollama",
          model: "local-model",
          usage,
          lastCallUsage,
        },
      },
    };
  });
}

function post(endpoint: "chat/completions" | "responses", body: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${port}/v1/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openclaw-scopes": "operator.write" },
    body: JSON.stringify({
      model: "openclaw",
      ...(endpoint === "responses"
        ? { input: "hi" }
        : { messages: [{ role: "user", content: "hi" }] }),
      ...body,
    }),
  });
}

const unavailableUsage = {
  input: 11,
  output: 7,
  total: 18,
  usageReport: { state: "unavailable" as const },
};
const earlierUsage = { input: 11, output: 7, total: 18 };

describe("OpenAI-compatible HTTP usage", () => {
  it("omits usage when a Responses stream fails before producing a result", async () => {
    agentCommandMock.mockClear();
    agentCommandMock.mockRejectedValueOnce(new Error("Synthetic run failure"));
    const res = await post("responses", { stream: true });
    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    const { response } = parseSseData(findSseEvent(events, "response.failed")) as {
      response: ResponseResource;
    };
    expect(response.status).toBe("failed");
    expect(response).not.toHaveProperty("usage");
    expect(events.filter((event) => event.data === "[DONE]")).toHaveLength(1);
  });

  it.each([false, true])(
    "omits unavailable Chat usage without losing the response (stream=%s)",
    async (stream) => {
      mockUsageResult(unavailableUsage, earlierUsage);
      const res = await post("chat/completions", {
        stream,
        stream_options: { include_usage: true },
      });
      expect(res.status).toBe(200);
      if (!stream) {
        const response = (await res.json()) as OpenAI.ChatCompletion;
        expect(response.choices[0]?.message.content).toBe("Partial answer");
        expect(response).not.toHaveProperty("usage");
        return;
      }
      const data = parseSseDataLines(await res.text());
      const chunks = data
        .filter((entry) => entry !== "[DONE]")
        .map((entry) => JSON.parse(entry) as OpenAI.ChatCompletionChunk);
      const choices = chunks.flatMap((chunk) => chunk.choices);
      expect(choices.map((choice) => choice.delta.content ?? "").join("")).toBe("Partial answer");
      expect(choices.map((choice) => choice.finish_reason).filter(Boolean)).toEqual(["stop"]);
      expect(chunks.every((chunk) => !("usage" in chunk))).toBe(true);
      expect(data.filter((entry) => entry === "[DONE]")).toHaveLength(1);
      expect(data.at(-1)).toBe("[DONE]");
    },
  );

  it.each([false, true])(
    "omits unavailable Responses usage without losing continuity (stream=%s)",
    async (stream) => {
      mockUsageResult(unavailableUsage, earlierUsage);
      const res = await post("responses", { stream });
      expect(res.status).toBe(200);
      const text = await res.text();
      const events = stream ? parseSseEvents(text) : [];
      const response = stream
        ? (
            parseSseData(findSseEvent(events, "response.completed")) as {
              response: ResponseResource;
            }
          ).response
        : (JSON.parse(text) as ResponseResource);
      expect(response.status).toBe("completed");
      expect(response.output).toMatchObject([
        { type: "message", content: [{ type: "output_text", text: "Partial answer" }] },
      ]);
      expect(response).not.toHaveProperty("usage");
      if (stream) {
        expect(
          collectSseEventTypes(events).filter((type) =>
            ["response.completed", "response.incomplete", "response.failed"].includes(type),
          ),
        ).toEqual(["response.completed"]);
        expect(events.filter((event) => event.data === "[DONE]")).toHaveLength(1);
        expect(events.at(-1)?.data).toBe("[DONE]");
      }

      const sessionKey = (agentCommandMock.mock.calls[0]?.[0] as { sessionKey: string } | undefined)
        ?.sessionKey;
      expect(sessionKey).toBeTypeOf("string");
      agentCommandMock.mockResolvedValueOnce({
        payloads: [{ text: "Continued", mediaUrl: null }],
        meta: { durationMs: 0 },
      });
      const continued = await post("responses", { previous_response_id: response.id });
      expect(continued.status).toBe(200);
      await continued.text();
      expect(agentCommandMock.mock.calls[1]?.[0]).toMatchObject({ sessionKey });
    },
  );

  it.each([
    {
      name: "includes aggregate usage in the final stream chunk",
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
      name: "uses last-call usage when the aggregate is zero",
      usage: { input: 0, output: 0, total: 0 },
      lastCallUsage: { input: 55, output: 7, total: 62 },
      expected: { prompt_tokens: 55, completion_tokens: 7, total_tokens: 62 },
    },
    {
      name: "preserves measured zero aggregate usage over an earlier call",
      usage: { input: 0, output: 0, total: 0, usageReport: { state: "available" as const } },
      lastCallUsage: { input: 55, output: 7, total: 62 },
      expected: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  ])("$name", async ({ usage, lastCallUsage, expected }) => {
    mockUsageResult(usage, lastCallUsage);
    const res = await post("chat/completions", {
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(res.status).toBe(200);
    const data = parseSseDataLines(await res.text());
    expect(data.at(-1)).toBe("[DONE]");
    const chunks = data
      .filter((entry) => entry !== "[DONE]")
      .map((entry) => JSON.parse(entry) as OpenAI.ChatCompletionChunk);
    const usageChunk = chunks.find((chunk) => "usage" in chunk);
    expect(usageChunk?.usage).toEqual(expected);
    expect(usageChunk?.choices).toStrictEqual([]);
  });
});
