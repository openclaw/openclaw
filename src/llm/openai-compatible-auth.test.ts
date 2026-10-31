import type { Context } from "@openclaw/ai";
import { streamOpenAICompletions, streamOpenAIResponses } from "@openclaw/ai/internal/openai";
import { afterEach, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { captureEnv } from "../test-utils/env.js";
// Importing the facade installs the OpenClaw AI transport host ports.
import "./stream.js";

const mocks = vi.hoisted(() => ({ fetchWithSsrFGuard: vi.fn() }));

vi.mock("../infra/net/fetch-guard.js", async () => ({
  ...(await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  )),
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

const originalEnv = captureEnv(["OPENAI_API_KEY"]);

afterEach(() => {
  originalEnv.restore();
  mocks.fetchWithSsrFGuard.mockReset();
});

const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } satisfies Context;

function createBaseModel<TApi extends "openai-completions" | "openai-responses">(api: TApi) {
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
    throw new Error("request captured");
  });

  await expect(
    streamOpenAICompletions(createBaseModel("openai-completions"), context, {
      apiKey: "sk-third-party",
    }).result(),
  ).resolves.toMatchObject({ stopReason: "error", errorMessage: "Connection error." });
  expect(capturedHeaders?.get("authorization")).toBe("Bearer sk-third-party");
});

it("does not replay Responses item ids for direct store-disabled requests", async () => {
  let capturedPayload: { store?: unknown; input?: Array<Record<string, unknown>> } | undefined;
  const model = { ...createBaseModel("openai-responses"), reasoning: true };
  const stream = streamOpenAIResponses(
    model,
    {
      messages: [
        makeAgentAssistantMessage({
          provider: model.provider,
          model: model.id,
          content: [
            {
              type: "thinking",
              thinking: "Need a tool.",
              thinkingSignature:
                '{"type":"reasoning","id":"rs_prior","encrypted_content":"ciphertext"}',
            },
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

  await expect(stream.result()).resolves.toMatchObject({
    stopReason: "error",
    errorMessage: "stop after payload",
  });
  expect(capturedPayload?.store).toBe(false);
  expect(capturedPayload?.input).toEqual([
    { type: "reasoning", encrypted_content: "ciphertext", summary: [] },
  ]);
});
