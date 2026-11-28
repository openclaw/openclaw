// Root integration scope: packages cannot import extensions, and test/helpers cannot own them.
import { GenerateContentResponse } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bedrockModel,
  mockStream,
  startEvent,
  stopEvent,
  streamBedrockForTest,
  textDelta,
} from "../extensions/amazon-bedrock/test-api.js";
import { createAppleFmStream } from "../extensions/apple-fm/test-api.js";
import { createGoogleGenerativeAiTransportStreamFn } from "../extensions/google/test-api.js";
import { streamModel, wrapLmstudioInferencePreload } from "../extensions/lmstudio/test-api.js";
import { createOllamaStreamFn } from "../extensions/ollama/test-api.js";
import {
  baseUrl as radiusBaseUrl,
  createRadiusStreamFn,
  usage as radiusUsage,
} from "../extensions/radius/test-api.js";
import { createApiRegistry } from "../packages/ai/src/api-registry.js";
import { configureAiTransportHost, getAiTransportHost } from "../packages/ai/src/host.js";
import {
  anthropicModel,
  createAnthropicResponse,
} from "../packages/ai/src/provider-transport-parity.test-support.js";
import {
  completedResponse,
  createJwt,
  sseResponse,
} from "../packages/ai/src/providers/openai-chatgpt-responses.test-helpers.js";
import { makeProviderModel } from "../packages/ai/src/providers/provider-model.test-support.js";
import { registerBuiltInApiProviders } from "../packages/ai/src/providers/register-builtins.js";
import type { Api, AssistantMessage, Model } from "../packages/ai/src/types.js";

const upstream = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  guardedFetch: vi.fn(),
  google: vi.fn(),
}));

// Match the provider suites' SDK boundaries; no adapter or usage projection is mocked.
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal()),
  GoogleGenAI: class {
    models = { generateContentStream: upstream.google };
  },
}));
vi.mock("openclaw/plugin-sdk/provider-transport-runtime", async (importOriginal) => ({
  ...(await importOriginal()),
  buildGuardedModelFetch: () => upstream.fetch,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchWithSsrFGuard: upstream.guardedFetch,
}));

const initialHost = getAiTransportHost();
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };
const options = { apiKey: "synthetic-context-contract", transport: "sse" as const };
const registry = createApiRegistry();
registerBuiltInApiProviders(registry);

afterEach(() => {
  configureAiTransportHost(initialHost);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function* events(values: unknown[]) {
  yield* values;
}

function respond(response: Response) {
  upstream.fetch.mockResolvedValue(response);
  // Built-ins use the package host; plugin transports use the guarded-fetch ports above.
  configureAiTransportHost({ ...initialHost, buildModelFetch: () => upstream.fetch });
  vi.stubGlobal("fetch", upstream.fetch);
}

function builtin(target: Model, apiKey = options.apiKey) {
  const provider = registry.getApiProvider(target.api);
  if (!provider) {
    throw new Error(`Unregistered contract API: ${target.api}`);
  }
  return provider.streamSimple(target, context, { ...options, apiKey }).result();
}

function model<A extends Api>(api: A, provider = "openai", id = "gpt-5.5") {
  return makeProviderModel(api, provider, id, {
    reasoning: false,
    baseUrl: "https://api.openai.com/v1",
  });
}

function completionsResponse(withUsage: boolean) {
  return sseResponse({
    id: "chatcmpl-contract",
    object: "chat.completion.chunk",
    created: 1,
    model: "contract",
    choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    ...(withUsage ? { usage: { prompt_tokens: 37, completion_tokens: 5, total_tokens: 42 } } : {}),
  });
}

function responsesResponse(withUsage: boolean) {
  const completed = completedResponse("resp_contract");
  const output = {
    type: "message",
    id: "msg_contract",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "hello", annotations: [] }],
  };
  return sseResponse(
    { type: "response.output_item.added", output_index: 0, item: { ...output, content: [] } },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hello" },
    { type: "response.output_item.done", output_index: 0, item: output },
    {
      ...completed,
      response: {
        id: "resp_contract",
        status: "completed",
        output: [output],
        ...(withUsage ? { usage: { input_tokens: 37, output_tokens: 5, total_tokens: 42 } } : {}),
      },
    },
  );
}

function geminiChunk(withUsage: boolean) {
  return {
    candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }],
    ...(withUsage
      ? { usageMetadata: { promptTokenCount: 37, candidatesTokenCount: 5, totalTokenCount: 42 } }
      : {}),
  };
}

type Row = {
  name: string;
  api?: Api;
  field: string;
  measured: number;
  total: number;
  // Apple FM validates both counts in its native resultSchema: no usage-less completed result exists.
  requiresUsage?: boolean;
  unmeasuredCase?: string;
  run: (withUsage: boolean) => Promise<AssistantMessage>;
};

const rows: Row[] = [
  {
    name: "anthropic-messages",
    api: "anthropic-messages",
    field: "message.usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens",
    measured: 37,
    total: 42,
    run: async (withUsage) => {
      respond(
        createAnthropicResponse([
          {
            type: "message_start",
            message: {
              id: "msg_contract",
              model: anthropicModel.id,
              ...(withUsage
                ? {
                    usage: {
                      input_tokens: 20,
                      cache_read_input_tokens: 10,
                      cache_creation_input_tokens: 7,
                      output_tokens: 0,
                    },
                  }
                : {}),
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "hello" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            ...(withUsage ? { usage: { output_tokens: 5 } } : {}),
          },
          { type: "message_stop" },
        ]),
      );
      return builtin({ ...anthropicModel, reasoning: false });
    },
  },
  {
    name: "openai-completions",
    api: "openai-completions",
    field: "usage.prompt_tokens",
    measured: 37,
    total: 42,
    run: async (withUsage) => {
      respond(completionsResponse(withUsage));
      return builtin(model("openai-completions"));
    },
  },
  {
    name: "mistral-conversations",
    api: "mistral-conversations",
    field: "usage.prompt_tokens",
    measured: 37,
    total: 42,
    run: async (withUsage) => {
      respond(
        sseResponse({
          id: "mistral-contract",
          object: "chat.completion.chunk",
          created: 1,
          model: "mistral-large-latest",
          choices: [
            { index: 0, finish_reason: "stop", delta: { role: "assistant", content: "hello" } },
          ],
          ...(withUsage
            ? { usage: { prompt_tokens: 37, completion_tokens: 5, total_tokens: 42 } }
            : {}),
        }),
      );
      return builtin(model("mistral-conversations", "mistral", "mistral-large-latest"));
    },
  },
  ...(["openai-responses", "azure-openai-responses", "openai-chatgpt-responses"] as const).map(
    (api): Row => ({
      name: api,
      api,
      field: "response.usage.input_tokens",
      measured: 37,
      total: 42,
      run: async (withUsage) => {
        respond(responsesResponse(withUsage));
        return builtin(
          model(api, api === "azure-openai-responses" ? "azure-openai-responses" : "openai"),
          api === "openai-chatgpt-responses" ? createJwt() : options.apiKey,
        );
      },
    }),
  ),
  ...(["google-generative-ai", "google-vertex"] as const).map((api): Row => ({
    name: api,
    api,
    field: "usageMetadata.promptTokenCount",
    measured: 37,
    total: 42,
    run: async (withUsage) => {
      upstream.google.mockResolvedValue(
        events([Object.assign(new GenerateContentResponse(), geminiChunk(withUsage))]),
      );
      return builtin(
        model(api, api === "google-vertex" ? "google-vertex" : "google", "gemini-2.5-flash"),
      );
    },
  })),
  {
    name: "google-interactions",
    api: "google-interactions",
    field: "interaction.usage.total_input_tokens",
    measured: 37,
    total: 42,
    run: async (withUsage) => {
      respond(
        sseResponse(
          { event_type: "step.delta", delta: { type: "text", text: "hello" } },
          {
            event_type: "interaction.completed",
            interaction: {
              status: "completed",
              ...(withUsage
                ? { usage: { total_input_tokens: 37, total_output_tokens: 5, total_tokens: 42 } }
                : {}),
            },
          },
        ),
      );
      return builtin(model("google-interactions", "google", "gemini-3-flash-preview"));
    },
  },
  {
    name: "bedrock",
    field: "metadata.usage.inputTokens",
    measured: 37,
    total: 42,
    run: async (withUsage) => {
      mockStream([
        startEvent,
        textDelta("hello"),
        stopEvent,
        ...(withUsage
          ? [{ metadata: { usage: { inputTokens: 37, outputTokens: 5, totalTokens: 42 } } }]
          : []),
      ]);
      return streamBedrockForTest(bedrockModel(), context, { region: "us-east-1" }).result();
    },
  },
  {
    name: "ollama",
    field: "prompt_eval_count",
    measured: 37,
    total: 42,
    run: async (withUsage) => {
      upstream.guardedFetch.mockResolvedValue({
        response: new Response(
          JSON.stringify({
            model: "qwen3.5",
            message: { role: "assistant", content: "hello" },
            done: true,
            done_reason: "stop",
            ...(withUsage ? { prompt_eval_count: 37, eval_count: 5 } : {}),
          }) + "\n",
        ),
        release: async () => {},
      });
      const stream = await createOllamaStreamFn("http://127.0.0.1:11434")(
        model("ollama", "ollama", "qwen3.5"),
        context,
        options,
      );
      return stream.result();
    },
  },
  {
    name: "lmstudio",
    field: "usage.prompt_tokens (delegated openai-completions)",
    measured: 37,
    total: 42,
    run: async (withUsage) => {
      respond(completionsResponse(withUsage));
      // Disable preloading; responseFormat selects LM Studio's real Completions delegation.
      const run = wrapLmstudioInferencePreload({
        provider: "lmstudio",
        modelId: "qwen3.5-0.8b",
        config: {
          models: {
            providers: {
              lmstudio: {
                baseUrl: "http://127.0.0.1:1234/v1",
                models: [],
                params: { preload: false },
              },
            },
          },
        },
      });
      const stream = await run(streamModel("http://127.0.0.1:1234/v1"), context, {
        ...options,
        responseFormat: { type: "object", properties: {} },
      });
      return stream.result();
    },
  },
  {
    name: "radius",
    field: "done.usage.input + cacheRead + cacheWrite",
    measured: 64,
    total: 76,
    // Radius validates every numeric count: the valid unmeasured terminal has zero counts.
    unmeasuredCase: "zero prompt usage (terminal requires numeric counts)",
    run: async (withUsage) => {
      respond(
        sseResponse(
          { type: "start" },
          { type: "text_start", contentIndex: 0 },
          { type: "text_delta", contentIndex: 0, delta: "hello" },
          { type: "text_end", contentIndex: 0, content: "hello" },
          {
            type: "done",
            reason: "stop",
            usage: withUsage
              ? radiusUsage
              : {
                  ...radiusUsage,
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                },
          },
        ),
      );
      return createRadiusStreamFn()(
        { ...model("pi-messages", "radius"), baseUrl: radiusBaseUrl },
        context,
        options,
      ).result();
    },
  },
  {
    name: "apple-fm",
    field: "native result.inputTokens (required by resultSchema)",
    measured: 37,
    total: 42,
    requiresUsage: true,
    run: async () => {
      const stream = await createAppleFmStream({
        run: async () => ({
          text: "hello",
          toolCalls: [],
          inputTokens: 37,
          outputTokens: 5,
        }),
      })(model("openai-completions", "apple-fm", "system"), context, options);
      return stream.result();
    },
  },
  {
    name: "google-plugin",
    field: "usageMetadata.promptTokenCount",
    measured: 37,
    total: 42,
    run: async (withUsage) => {
      respond(sseResponse(geminiChunk(withUsage)));
      const stream = await createGoogleGenerativeAiTransportStreamFn()(
        {
          ...model("google-generative-ai", "google", "gemini-2.5-flash"),
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        },
        context,
        options,
      );
      return stream.result();
    },
  },
];

describe("completed transport context-usage contract", () => {
  it("covers exactly the registered built-in APIs", () => {
    expect(
      registry
        .getApiProviders()
        .map(({ api }) => api)
        .toSorted(),
    ).toEqual(rows.flatMap(({ api }) => (api ? [api] : [])).toSorted());
  });

  const cases = rows.flatMap(
    ({ name, field, run, measured, total, requiresUsage, unmeasuredCase }) =>
      (requiresUsage ? [true] : [true, false]).map((withUsage) => ({
        name,
        field,
        run,
        measured,
        total,
        withUsage,
        case: withUsage ? "measured usage" : (unmeasuredCase ?? "no usage"),
      })),
  );
  it.each(cases)("$name: $case [$field]", async ({ run, withUsage, measured, total }) => {
    const result = await run(withUsage);
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "hello" })]),
    );
    expect(result.usage.contextUsage).toEqual(
      withUsage
        ? { state: "available", promptTokens: measured, totalTokens: total }
        : { state: "unavailable" },
    );
  });
});
