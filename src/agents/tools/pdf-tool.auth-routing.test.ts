import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as llmStream from "../../llm/stream.js";
import * as pdfExtract from "../../media/pdf-extract.js";
import * as webMedia from "../../media/web-media.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { persistAuthProfileBatch } from "../auth-profiles/upsert-with-lock.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { AuthStorage } from "../sessions/auth-storage.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import { createPdfTool } from "./pdf-tool.js";
import {
  FAKE_PDF_MEDIA,
  resetPdfToolAuthEnv,
  withTempPdfAgentDir,
} from "./pdf-tool.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("PDF model authentication routing", () => {
  it.each(["API key", "OAuth"])(
    "uses available %s auth when the chat harness is Codex",
    async (mode) => {
      resetPdfToolAuthEnv();
      vi.stubEnv("CODEX_API_KEY", "");
      vi.stubEnv("OPENAI_API_KEY", "fixture-pdf-platform-key");
      await withTempPdfAgentDir(async (agentDir) => {
        if (mode === "OAuth") {
          await persistAuthProfileBatch({
            agentDir,
            profiles: [
              {
                profileId: "openai:pdf-fixture",
                credential: {
                  type: "oauth",
                  provider: "openai",
                  access: "fixture-pdf-oauth-access",
                  refresh: "fixture-pdf-oauth-refresh",
                  expires: Date.now() + 3_600_000,
                },
              },
            ],
          });
        }
        const modelId = "gpt-5.6-luna";
        const config: OpenClawConfig = {
          plugins: { entries: { openai: { enabled: true }, codex: { enabled: true } } },
          agents: {
            defaults: {
              model: { primary: `openai/${modelId}` },
              pdfModel: { primary: `openai/${modelId}` },
            },
          },
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
        const metadataSnapshot = createPluginMetadataSnapshotFixture({
          plugins: [{ id: "openai", providers: ["openai"], enabledByDefault: true }],
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
          metadataSnapshot,
          pluginRegistry,
          allowGatewaySubagentBinding: false,
          modelCatalog: { entries: [], routeVariants: [] },
          configuredRuntimeModels: [],
          findConfiguredRuntimeModel: () => undefined,
          inlineProviderModels: [],
          createStores: () => {
            const authStorage = AuthStorage.inMemory({
              openai: { type: "api_key", key: "fixture-pdf-platform-key" },
            });
            return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
          },
        } satisfies PreparedModelRuntimeSnapshot;
        vi.spyOn(webMedia, "loadWebMediaRaw").mockResolvedValue(FAKE_PDF_MEDIA);
        vi.spyOn(pdfExtract, "extractPdfContent").mockResolvedValue({
          text: "The selected page contains the answer.",
          images: [],
        });
        const complete = vi
          .spyOn(llmStream, "completeSimple")
          .mockImplementation(async (model) => ({
            role: "assistant",
            content: [{ type: "text", text: "PDF answer" }],
            stopReason: "stop",
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: 0,
            usage: {
              input: 0,
              output: 0,
              totalTokens: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          }));
        const tool = createPdfTool({ config, agentDir, preparedModelRuntime });
        if (!tool) {
          throw new Error("PDF tool was not registered");
        }
        const result = await tool.execute("pdf-auth", {
          pdf: "/tmp/doc.pdf",
          pages: "21",
          prompt: "Summarize this page.",
        });
        expect(result.content).toEqual([{ type: "text", text: "PDF answer" }]);
        expect(complete).toHaveBeenCalledWith(
          expect.objectContaining({
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
          expect.anything(),
          expect.objectContaining({
            apiKey: mode === "OAuth" ? "fixture-pdf-oauth-access" : "fixture-pdf-platform-key",
          }),
          expect.any(Function),
        );
      });
    },
  );
});
