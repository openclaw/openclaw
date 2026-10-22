import type { Context, Model, StreamFn } from "@openclaw/ai";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { Type } from "typebox";
import { afterAll, beforeAll, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../../packages/ai/src/host.js";
import { makeProviderModel } from "../../packages/ai/src/providers/provider-model.test-support.js";
import { createOpenAICompletionsTransportStreamFn } from "../../packages/ai/src/transports/openai-completions-transport.js";
import { resolveOpenAIStrictToolSetting } from "../../src/agents/openai-strict-tool-setting.js";
import { resolveProviderRequestCapabilities } from "../../src/agents/provider-attribution.js";
import { normalizeModelCompat } from "../../src/plugins/provider-model-compat.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";

const publicUrl = "https://openrouter.ai/api/v1";
const makeRoute = (
  name: string,
  overrides: Partial<Model<"openai-completions">> & { omitStrict?: boolean; native?: boolean } = {},
) => ({
  ...makeProviderModel("openai-completions", "openrouter", "openai/gpt-5.4-mini", {
    baseUrl: publicUrl,
    reasoning: false,
  }),
  name,
  native: false,
  omitStrict: false,
  ...overrides,
});
const routes = [
  makeRoute("OpenAI"),
  makeRoute("Anthropic", { id: "anthropic/claude-sonnet-4.6" }),
  makeRoute("Gemini", { id: "google/gemini-3-flash-preview" }),
  makeRoute("automatic", { id: "openrouter/auto" }),
  makeRoute("custom provider on OpenRouter", { provider: "custom" }),
  makeRoute("custom proxy", { baseUrl: "https://proxy.example.test/v1", omitStrict: true }),
  makeRoute("explicit opt-out", { compat: { supportsStrictMode: false }, omitStrict: true }),
  makeRoute("native OpenAI", {
    id: "gpt-5.4-mini",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    native: true,
  }),
];

type CapturedRequest = {
  model: string;
  tools: Array<{
    function: { strict?: boolean; parameters: { required: string[]; properties: unknown } };
  }>;
};

let originalHost: ReturnType<typeof getAiTransportHost>;
let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
let captured: { url: string; body: CapturedRequest };

beforeAll(async () => {
  const { default: plugin } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "openrouter", artifactBasename: "index.js" });
  provider = await registerSingleProviderPlugin(plugin);
  // Plugin loading can install the runtime host; preserve that initialization on cleanup.
  originalHost = getAiTransportHost();
  configureAiTransportHost({
    ...originalHost,
    resolveProviderRequestCapabilities,
    resolveOpenAIStrictToolSetting,
    requiresManagedTransport: () => true,
    // Replace only external I/O, after the real SDK has serialized the request.
    buildModelFetch: () => async (input, init) => {
      const request = new Request(input, init);
      captured = { url: request.url, body: JSON.parse(await request.text()) };
      return new Response(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
});

afterAll(() => configureAiTransportHost(originalHost));

it.each(
  (["managed", "direct"] as const).flatMap((mode) => routes.map((route) => ({ mode, route }))),
)("OpenRouter preserves optional inputs for $mode $route.name", async ({ mode, route }) => {
  const { native, omitStrict, ...input } = route;
  const model = { ...normalizeModelCompat(input), api: input.api };
  const properties = {
    action: Type.String(),
    targetId: native ? Type.String() : Type.Optional(Type.String()),
  };
  const parameters = Type.Object(
    native
      ? properties
      : {
          ...properties,
          timeoutMs: Type.Optional(Type.Number()),
          fullPage: Type.Optional(Type.Boolean()),
        },
    { additionalProperties: false },
  );
  const tools = [
    {
      name: "browser",
      label: "Browser",
      description: "Manage browser tabs.",
      parameters,
      execute: async () => ({ content: [], details: {} }),
    },
  ];
  // Run the bundled plugin's schema and payload hooks before the managed transport.
  const context: Context = {
    messages: [{ role: "user", content: "List the open browser tabs.", timestamp: 1 }],
    tools: native
      ? tools
      : (provider.normalizeToolSchemas?.({
          provider: model.provider,
          modelId: model.id,
          modelApi: model.api,
          model,
          tools,
        }) ?? tools),
  };
  const baseStream: StreamFn =
    mode === "managed"
      ? createOpenAICompletionsTransportStreamFn()
      : (runtimeModel, runtimeContext, options) =>
          streamOpenAICompletions(
            { ...runtimeModel, api: "openai-completions" },
            runtimeContext,
            options,
          );
  const streamFn = native
    ? baseStream
    : (provider.wrapStreamFn?.({
        provider: model.provider,
        modelId: model.id,
        model,
        streamFn: baseStream,
      }) ?? baseStream);
  const result = await (await streamFn(model, context, { apiKey: "synthetic-key" })).result();
  expect(result.stopReason).toBe("stop");
  expect(captured.url).toBe(`${route.baseUrl}/chat/completions`);
  expect(captured.body.model).toBe(route.id);
  const tool = captured.body.tools[0]!.function;
  if (omitStrict) {
    expect(tool).not.toHaveProperty("strict");
  } else {
    expect(tool.strict).toBe(native && mode === "managed");
  }
  expect(tool.parameters.required).toEqual(native ? ["action", "targetId"] : ["action"]);
  expect(tool.parameters.properties).toHaveProperty(native ? "targetId" : "fullPage");
});
