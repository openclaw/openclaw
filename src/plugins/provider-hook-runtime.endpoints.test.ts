import { afterAll, afterEach, expect, it } from "vitest";
import {
  attachModelProviderRequestRouteFacts,
  getModelProviderRequestRouteFacts,
} from "../agents/provider-request-config.js";
import { loadAgentRuntimePluginRegistryHandle } from "../agents/runtime-plugins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
  makePluginLoaderTempDir,
} from "./loader.test-fixtures.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { resolveProviderRuntimePluginHandle } from "./provider-hook-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";

afterEach(clearPluginLoaderCache);
afterAll(cleanupPluginLoaderFixturesForTest);

it.each([
  { name: "enabled", plugins: { allow: ["qwen"] }, expected: "qwen" },
  { name: "disabled", plugins: { entries: { qwen: { enabled: false } } }, expected: undefined },
  { name: "denied", plugins: { deny: ["qwen"] }, expected: undefined },
])("cold-resolves custom DashScope hooks with the owner $name", ({ plugins, expected }) => {
  const provider = "custom-dashscope";
  const config: OpenClawConfig = {
    plugins,
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
          api: "openai-completions",
          apiKey: "synthetic-not-a-real-key",
          models: [
            {
              id: "qwen3.8",
              name: "Fixture",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 1000,
            },
          ],
        },
      },
    },
  };
  const env = { OPENCLAW_STATE_DIR: makePluginLoaderTempDir() };
  const snapshot = loadPluginMetadataSnapshot({ config, env });
  setActivePluginRegistry(createEmptyPluginRegistry());
  const model = attachModelProviderRequestRouteFacts(
    {
      provider,
      id: "qwen3.8",
      api: "openai-completions",
      baseUrl: config.models!.providers![provider]!.baseUrl,
    },
    snapshot.owners,
  );
  const providerOwner = getModelProviderRequestRouteFacts(model)?.providerOwner;
  expect(providerOwner).toBe("modelstudio-native");
  const pluginRegistry = loadAgentRuntimePluginRegistryHandle({
    config,
    env,
    metadataSnapshot: snapshot,
    workspaceDir: makePluginLoaderTempDir(),
    basePluginIds: [],
    selections: [{ provider, modelId: model.id }],
  });
  const handle = withPluginRuntimeGenerationScope(
    { metadataSnapshot: snapshot, pluginRegistry },
    () =>
      resolveProviderRuntimePluginHandle({
        provider,
        providerOwner,
        modelId: model.id,
        config,
        env,
        pluginMetadataSnapshot: snapshot,
      }),
  );
  expect(handle.plugin?.id).toBe(expected);
  if (!expected) {
    return;
  }
  expect(
    handle.plugin?.classifyFailoverReason?.({
      provider,
      status: 429,
      code: "insufficient_quota",
      errorMessage: "Free allocated quota exceeded.",
    }),
  ).toBe("billing");
});
