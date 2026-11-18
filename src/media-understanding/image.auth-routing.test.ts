import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { createEmptyPreparedModelRuntimeFixture } from "../agents/embedded-agent-runner/model.fixture.test-support.js";
import * as providerStream from "../agents/provider-stream.js";
import { AuthStorage } from "../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import {
  createRequiredImageTool,
  ONE_PIXEL_PNG_B64,
} from "../agents/tools/image-tool.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
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
  {
    name: "ChatGPT OAuth from the agent store",
    supplied: false,
    requiredWorker: false,
    tool: false,
  },
  {
    name: "ChatGPT OAuth from a caller-supplied store",
    supplied: true,
    requiredWorker: false,
    tool: false,
  },
  {
    name: "an API key with a required worker profile",
    supplied: false,
    requiredWorker: true,
    tool: false,
  },
  {
    name: "the configured-model tool with a required worker runtime",
    supplied: false,
    requiredWorker: true,
    tool: true,
  },
])("describes an image using $name", async (scenario) => {
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("CODEX_API_KEY", "");
  await withOpenClawTestState({ label: "image-auth-routing" }, async (state) => {
    const agentDir = state.agentDir();
    const credential = scenario.requiredWorker
      ? createApiKeyCredential("openai", "image-api-key")
      : createOAuthRefreshCredential({ expires: Date.now() + 3_600_000 });
    if (!scenario.supplied) {
      await persistAuthProfileBatch({
        agentDir,
        profiles: [{ profileId: "openai:image-fixture", credential }],
      });
    }
    const modelId = "gpt-5.6-luna";
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir, imageModel: `openai/${modelId}` } },
      plugins: { entries: { openai: { enabled: true } } },
      ...(scenario.requiredWorker ? { cloudWorkers: { requiredProfile: "required" } } : {}),
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

    const request = {
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
    };
    if (scenario.tool) {
      // Worker turns retain their config and prepared runtime in the Gateway-owned tool.
      // Exercise that configured-model path without inventing a worker inference authority.
      const tool = createRequiredImageTool({
        config,
        agentDir,
        workspaceDir: state.workspaceDir,
        preparedModelRuntime,
        modelHasVision: false,
      });
      const result = await withPluginRuntimeGenerationScope(preparedModelRuntime, () =>
        tool.execute("required-worker-image", {
          path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
          prompt: request.prompt,
        }),
      );
      expect(result.content).toContainEqual({ type: "text", text: "A cat." });
    } else {
      expect(await describeImageWithModelCore(request)).toEqual({ text: "A cat.", model: modelId });
    }
    expect(streamed).toHaveBeenCalledExactlyOnceWith({
      model: expect.objectContaining({
        provider: "openai",
        id: modelId,
        api: scenario.requiredWorker
          ? "openai-responses"
          : expect.stringContaining("openai-chatgpt-responses"),
        baseUrl: scenario.requiredWorker
          ? "https://api.openai.com/v1"
          : "https://chatgpt.com/backend-api/codex",
      }),
      apiKey: scenario.requiredWorker ? "image-api-key" : "access-token",
    });
  });
});
