import { beforeAll, describe, expect, it } from "vitest";
import { resolveRuntimeHooks } from "../../src/agents/embedded-agent-runner/model.provider-hooks.js";
import { resolveModelWithRegistry } from "../../src/agents/embedded-agent-runner/model.registry-resolution.js";
import { buildOpenAICompletionsParams } from "../../src/agents/openai-transport-stream.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";

const serving = "https://workspace.example/serving-endpoints/";
const unity = "https://workspace.example/ai-gateway/mlflow/v1";
let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;

beforeAll(async () => {
  const plugin = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "databricks", artifactBasename: "index.js" });
  provider = await registerSingleProviderPlugin(plugin.default);
});

describe("configured Databricks chat requests", () => {
  it.each([
    ["workspace serving", serving, undefined, undefined, "max_tokens"],
    ["model-level serving route", unity, serving, undefined, "max_tokens"],
    [
      "explicit model compatibility",
      serving,
      undefined,
      "max_completion_tokens",
      "max_completion_tokens",
    ],
    ["model-level Unity route", serving, unity, undefined, "max_completion_tokens"],
  ] as const)(
    "uses the token limit for %s",
    async (_case, baseUrl, modelBaseUrl, maxTokensField, field) => {
      const modelId = "weather-endpoint";
      const model = await resolveModelWithRegistry({
        provider: "databricks",
        modelId,
        cfg: {
          models: {
            providers: {
              databricks: {
                api: "openai-completions",
                baseUrl,
                models: [
                  {
                    id: modelId,
                    name: "Configured endpoint",
                    baseUrl: modelBaseUrl,
                    input: ["text"],
                    reasoning: false,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 4096,
                    maxTokens: 512,
                    compat: { supportsDeveloperRole: false, maxTokensField },
                  },
                ],
              },
            },
          },
        },
        modelRegistry: {
          getAll: () => [],
          getAvailable: () => [],
          find: () => undefined,
          hasConfiguredAuth: () => false,
        },
        runtimeHooks: {
          ...resolveRuntimeHooks({ skipProviderRuntimeHooks: true }),
          normalizeProviderResolvedModelWithPlugin: ({ context }) =>
            provider.normalizeResolvedModel?.(context),
          runProviderDynamicModel: () => {
            throw new Error("configured endpoint should resolve before discovery");
          },
        },
        authProfileMode: "api_key",
      });
      if (!model) {
        throw new Error("configured Databricks endpoint did not resolve");
      }
      expect(model).toMatchObject({
        id: modelId,
        name: "Configured endpoint",
        baseUrl: (modelBaseUrl ?? baseUrl).replace(/\/$/, ""),
        compat: { supportsDeveloperRole: false },
      });
      const body = buildOpenAICompletionsParams(model, { messages: [] }, { maxTokens: 128 });
      expect(body).toHaveProperty(field, 128);
      expect(body).not.toHaveProperty(
        field === "max_tokens" ? "max_completion_tokens" : "max_tokens",
      );
    },
  );
});
