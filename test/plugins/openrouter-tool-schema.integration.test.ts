import type { Context, Model, StreamFn } from "@openclaw/ai";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../../packages/ai/src/host.js";
import { createOpenAICompletionsTransportStreamFn } from "../../packages/ai/src/transports/openai-completions-transport.js";
import { resolveOpenAIStrictToolSetting } from "../../src/agents/openai-strict-tool-setting.js";
import { resolveProviderRequestCapabilities } from "../../src/agents/provider-attribution.js";
import { normalizeModelCompat } from "../../src/plugins/provider-model-compat.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";

const publicUrl = "https://openrouter.ai/api/v1";
const routes = [
  { name: "OpenAI", id: "openai/gpt-5.4-mini", baseUrl: publicUrl },
  { name: "Anthropic", id: "anthropic/claude-sonnet-4.6", baseUrl: publicUrl },
  { name: "Gemini", id: "google/gemini-3-flash-preview", baseUrl: publicUrl },
  { name: "automatic", id: "openrouter/auto", baseUrl: publicUrl },
  {
    name: "custom provider on OpenRouter",
    id: "openai/gpt-5.4-mini",
    baseUrl: publicUrl,
    provider: "custom",
  },
  {
    name: "custom proxy",
    id: "openai/gpt-5.4-mini",
    baseUrl: "https://proxy.example.test/v1",
    omitStrict: true,
  },
  {
    name: "explicit opt-out",
    id: "openai/gpt-5.4-mini",
    baseUrl: publicUrl,
    compat: { supportsStrictMode: false },
    omitStrict: true,
  },
  {
    name: "native OpenAI",
    id: "gpt-5.4-mini",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    native: true,
  },
] as const;

type CapturedRequest = {
  model: string;
  tools: Array<{
    function: { strict?: boolean; parameters: { required: string[]; properties: unknown } };
  }>;
};

describe("OpenRouter serialized tool schema policy", () => {
  let originalHost: ReturnType<typeof getAiTransportHost>;
  let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
  let captured: { url: string; body: CapturedRequest };

  beforeAll(async () => {
    originalHost = getAiTransportHost();
    const { default: plugin } = await loadBundledPluginFacade<{
      default: Parameters<typeof registerSingleProviderPlugin>[0];
    }>({ pluginId: "openrouter", artifactBasename: "index.js" });
    provider = await registerSingleProviderPlugin(plugin);
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
            id: "synthetic-completion",
            object: "chat.completion.chunk",
            created: 1,
            model: "synthetic",
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
  )("preserves optional inputs for $mode $route.name", async ({ mode, route }) => {
    const input: Model<"openai-completions"> = {
      id: route.id,
      name: route.name,
      api: "openai-completions",
      provider: "provider" in route ? route.provider : "openrouter",
      baseUrl: route.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
      ...("compat" in route ? { compat: route.compat } : {}),
    };
    const model = { ...normalizeModelCompat(input), api: input.api };
    const native = "native" in route;
    const tools = [
      {
        name: "browser",
        label: "Browser",
        description: "Manage browser tabs.",
        parameters: native
          ? Type.Object(
              { action: Type.String(), targetId: Type.String() },
              { additionalProperties: false },
            )
          : Type.Object(
              {
                action: Type.String(),
                targetId: Type.Optional(Type.String()),
                url: Type.Optional(Type.String()),
                selector: Type.Optional(Type.String()),
                timeoutMs: Type.Optional(Type.Number()),
                fullPage: Type.Optional(Type.Boolean()),
              },
              { additionalProperties: false },
            ),
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
    if ("omitStrict" in route) {
      expect(tool).not.toHaveProperty("strict");
    } else {
      expect(tool.strict).toBe(native && mode === "managed");
    }
    expect(tool.parameters.required).toEqual(native ? ["action", "targetId"] : ["action"]);
    expect(tool.parameters.properties).toHaveProperty(native ? "targetId" : "fullPage");
  });
});
