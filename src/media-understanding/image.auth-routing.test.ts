import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import * as providerStream from "../agents/provider-stream.js";
import { AuthStorage } from "../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import { makeAssistantMessageFixture } from "../agents/test-helpers/assistant-message-fixtures.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { describeImageWithModelCore } from "./image.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("image model authentication routing", () => {
  it.each([
    ["OAuth", false],
    ["API key", true],
  ] as const)(
    "uses the %s credential the OpenAI route selects (Codex: %s)",
    async (mode, codex) => {
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
      vi.stubEnv("OPENAI_API_KEY", mode === "API key" ? "fixture-image-platform-key" : "");
      vi.stubEnv("CODEX_API_KEY", "");
      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-auth-"));
      try {
        if (mode === "OAuth") {
          await persistAuthProfileBatch({
            agentDir,
            profiles: [
              {
                profileId: "openai:image-fixture",
                credential: {
                  type: "oauth",
                  provider: "openai",
                  access: "fixture-image-oauth-access",
                  refresh: "fixture-image-oauth-refresh",
                  expires: Date.now() + 3_600_000,
                },
              },
            ],
          });
        }
        const modelId = "gpt-5.6-luna";
        const config: OpenClawConfig = {
          plugins: {
            entries: { openai: { enabled: true }, ...(codex ? { codex: { enabled: true } } : {}) },
          },
          agents: { defaults: { imageModel: { primary: `openai/${modelId}` } } },
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
          catalogOwner: undefined,
          agentDir,
          workspaceDir: agentDir,
          activeProjectKeys: [],
          config,
          observationConfig: config,
          isCurrent: () => true,
          authModes: { openai: "api_key" },
          metadataSnapshot: createPluginMetadataSnapshotFixture({
            plugins: [{ id: "openai", providers: ["openai"], enabledByDefault: true }],
          }),
          pluginRegistry,
          allowGatewaySubagentBinding: false,
          modelCatalog: { entries: [], routeVariants: [] },
          configuredRuntimeModels: [],
          findConfiguredRuntimeModel: () => undefined,
          inlineProviderModels: [],
          createStores: () => {
            const authStorage = AuthStorage.inMemory({});
            return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
          },
        } satisfies PreparedModelRuntimeSnapshot;
        const streamed = vi.fn();
        vi.spyOn(providerStream, "registerProviderStreamForModel").mockReturnValue(
          async (model, _context, options) => {
            streamed({ model, apiKey: options?.apiKey });
            const stream = {
              result: async () =>
                makeAssistantMessageFixture({
                  content: [{ type: "text", text: "A cat." }],
                  stopReason: "stop",
                  errorMessage: undefined,
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                }),
            };
            return stream as never;
          },
        );

        const result = await describeImageWithModelCore({
          buffer: Buffer.from("fixture-image"),
          fileName: "cat.png",
          mime: "image/png",
          provider: "openai",
          model: modelId,
          prompt: "Describe the image.",
          timeoutMs: 30_000,
          cfg: config,
          agentDir,
          workspaceDir: agentDir,
          preparedModelRuntime,
        });

        expect(result.text).toBe("A cat.");
        expect(streamed).toHaveBeenCalledWith({
          model: expect.objectContaining({
            provider: "openai",
            id: modelId,
            api:
              mode === "OAuth"
                ? expect.stringContaining("openai-chatgpt-responses")
                : "openai-responses",
            baseUrl:
              mode === "OAuth"
                ? "https://chatgpt.com/backend-api/codex"
                : "https://api.openai.com/v1",
          }),
          apiKey: mode === "OAuth" ? "fixture-image-oauth-access" : "fixture-image-platform-key",
        });
      } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
      }
    },
  );
});
