import type { Context, Model } from "@openclaw/ai";
import { streamOpenAICompletions, streamOpenAIResponses } from "@openclaw/ai/internal/openai";
import { afterEach, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { captureEnv } from "../test-utils/env.js";
// Importing the facade installs the OpenClaw AI transport host ports.
import "./stream.js";

const mocks = vi.hoisted(() => ({ fetchWithSsrFGuard: vi.fn() }));

vi.mock("../infra/net/fetch-guard.js", async () => {
  return {
    ...(await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
      "../infra/net/fetch-guard.js",
    )),
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

const originalEnv = captureEnv(["OPENAI_API_KEY"]);

afterEach(() => {
  originalEnv.restore();
  mocks.fetchWithSsrFGuard.mockReset();
});

const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } satisfies Context;

function createBaseModel<TApi extends "openai-completions" | "openai-responses">(
  api: TApi,
): Model<TApi> {
  return makeProviderModelFixture<TApi>({
    id: "custom-model",
    api,
    provider: "custom-openai-compatible",
    baseUrl: "https://third-party.test/v1",
  });
}

it.each(["openai-completions", "openai-responses"] as const)(
  "does not use ambient OPENAI_API_KEY for generic %s providers",
  async (api) => {
    process.env.OPENAI_API_KEY = "sk-openai-ambient";
    const stream =
      api === "openai-completions"
        ? streamOpenAICompletions(createBaseModel(api), context)
        : streamOpenAIResponses(createBaseModel(api), context);
    expect(await stream.result()).toMatchObject({
      stopReason: "error",
      errorMessage: "No API key for provider: custom-openai-compatible",
    });
  },
);

it("sends explicit API keys as bearer auth for generic chat-completions providers", async () => {
  let capturedHeaders: Headers | undefined;
  mocks.fetchWithSsrFGuard.mockImplementationOnce(async (params: { init?: RequestInit }) => {
    capturedHeaders = new Headers(params.init?.headers);
    return {
      response: new Response(
        [
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"custom-model","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"custom-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
      release: async () => undefined,
    };
  });

  const stream = streamOpenAICompletions(createBaseModel("openai-completions"), context, {
    apiKey: "sk-third-party",
  });
  const result = await stream.result();

  expect(result.stopReason).toBe("stop");
  expect(capturedHeaders?.get("authorization")).toBe("Bearer sk-third-party");
});

it("does not replay Responses item ids for direct store-disabled requests", async () => {
  let capturedPayload: { store?: unknown; input?: Array<Record<string, unknown>> } | undefined;
  const model = {
    ...createBaseModel("openai-responses"),
    reasoning: true,
  } satisfies Model<"openai-responses">;
  const stream = streamOpenAIResponses(
    model,
    {
      messages: [
        makeAgentAssistantMessage({
          provider: model.provider,
          model: model.id,
          stopReason: "toolUse",
          timestamp: 1,
          content: [
            {
              type: "thinking",
              thinking: "Need a tool.",
              thinkingSignature:
                '{"type":"reasoning","id":"rs_prior","encrypted_content":"ciphertext"}',
            },
            {
              type: "text",
              text: "Checking.",
              textSignature: JSON.stringify({ v: 1, id: "msg_prior", phase: "commentary" }),
            },
            { type: "toolCall", id: "call_abc|fc_prior", name: "lookup", arguments: {} },
          ],
        }),
      ],
    },
    {
      apiKey: "sk-test",
      onPayload: (payload) => {
        capturedPayload = payload as typeof capturedPayload;
        throw new Error("stop after payload");
      },
    },
  );

  const result = await stream.result();

  expect(result).toMatchObject({ stopReason: "error", errorMessage: "stop after payload" });
  expect(capturedPayload?.store).toBe(false);
  for (const expected of [
    { type: "reasoning", encrypted_content: "ciphertext", summary: [] },
    { type: "message", phase: "commentary" },
    { type: "function_call", call_id: "call_abc" },
  ]) {
    const item = capturedPayload?.input?.find((candidate) => candidate.type === expected.type);
    expect(item).toMatchObject(expected);
    expect(item).not.toHaveProperty("id");
  }
});
