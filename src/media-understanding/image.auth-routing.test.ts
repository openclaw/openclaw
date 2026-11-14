import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOAuthRefreshCredential } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { createEmptyPreparedModelRuntimeFixture } from "../agents/embedded-agent-runner/model.fixture.test-support.js";
import * as providerStream from "../agents/provider-stream.js";
import { AuthStorage } from "../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { describeImageWithModelCore } from "./image.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// gpt-5.6-luna has a Platform route and a ChatGPT route. Resolving the model first returns the
// Platform route, which rejects a ChatGPT OAuth profile. The credential must pick the route.
// A caller can supply the run attempt's store, which holds a profile the agent store lacks.
it.each([
  { name: "the agent store", supplied: false },
  { name: "a caller-supplied store", supplied: true },
])("describes an image with ChatGPT OAuth as the only credential, from $name", async (scenario) => {
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("CODEX_API_KEY", "");
  await withOpenClawTestState({ label: "image-auth-routing" }, async (state) => {
    const agentDir = state.agentDir();
    const credential = createOAuthRefreshCredential({ expires: Date.now() + 3_600_000 });
    if (!scenario.supplied) {
      await persistAuthProfileBatch({
        agentDir,
        profiles: [{ profileId: "openai:image-fixture", credential }],
      });
    }
    const modelId = "gpt-5.6-luna";
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir } },
      plugins: { entries: { openai: { enabled: true } } },
    };
    const { buildOpenAIProvider } = await loadBundledPluginFacade<{
      buildOpenAIProvider: () => ProviderPlugin;
    }>({ pluginId: "openai", artifactBasename: "api.js" });
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push({
      pluginId: "openai",
      source: path.resolve("extensions/openai/index.ts"),
      provider: buildOpenAIProvider(),
    });
    const preparedModelRuntime = {
      ...createEmptyPreparedModelRuntimeFixture({
        agentDir,
        config,
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "openai", providers: ["openai"], enabledByDefault: true }],
        }),
        createStores: () => {
          const authStorage = AuthStorage.inMemory({});
          return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
        },
      }),
      workspaceDir: state.workspaceDir,
      pluginRegistry,
    };
    const streamed = vi.fn();
    vi.spyOn(providerStream, "registerProviderStreamForModel").mockReturnValue(
      async (model, _context, options) => {
        streamed({ model, apiKey: options?.apiKey });
        const stream = {
          result: async () =>
            makeAgentAssistantMessage({
              content: [{ type: "text", text: "A cat." }],
              api: model.api,
              provider: model.provider,
              model: model.id,
            }),
        };
        return stream as never;
      },
    );

    const described = await describeImageWithModelCore({
      buffer: Buffer.from("fixture-image"),
      fileName: "cat.png",
      mime: "image/png",
      provider: "openai",
      model: modelId,
      prompt: "Describe the image.",
      timeoutMs: 30_000,
      cfg: config,
      agentDir,
      workspaceDir: state.workspaceDir,
      preparedModelRuntime,
      ...(scenario.supplied
        ? { authStore: { version: 1, profiles: { "openai:image-fixture": credential } } }
        : {}),
    });

    expect(described).toEqual({ text: "A cat.", model: modelId });
    expect(streamed).toHaveBeenCalledExactlyOnceWith({
      model: expect.objectContaining({
        provider: "openai",
        id: modelId,
        api: expect.stringContaining("openai-chatgpt-responses"),
        baseUrl: "https://chatgpt.com/backend-api/codex",
      }),
      apiKey: "access-token",
    });
  });
});
