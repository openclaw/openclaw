import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as llmStream from "../../llm/stream.js";
import * as pdfExtract from "../../media/pdf-extract.js";
import * as webMedia from "../../media/web-media.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createOAuthRefreshCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { persistAuthProfileBatch } from "../auth-profiles/upsert-with-lock.js";
import { createEmptyPreparedModelRuntimeFixture } from "../embedded-agent-runner/model.fixture.test-support.js";
import { AuthStorage } from "../sessions/auth-storage.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
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

it.each(["API key", "OAuth"])("routes %s PDF auth with Codex chat", async (mode) => {
  const oauth = mode === "OAuth";
  resetPdfToolAuthEnv();
  vi.stubEnv("CODEX_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "platform-key");
  await withTempPdfAgentDir(async (agentDir) => {
    if (oauth) {
      await persistAuthProfileBatch({
        agentDir,
        profiles: [
          {
            profileId: "openai:pdf-fixture",
            credential: createOAuthRefreshCredential({ expires: Date.now() + 3_600_000 }),
          },
        ],
      });
    }
    const modelId = "gpt-5.6-luna";
    const model = { primary: `openai/${modelId}` };
    const config: OpenClawConfig = {
      plugins: { entries: { openai: { enabled: true }, codex: { enabled: true } } },
      agents: { defaults: { model, pdfModel: model } },
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
      ...createEmptyPreparedModelRuntimeFixture({
        agentDir,
        config,
        metadataSnapshot,
        createStores: () => {
          const authStorage = AuthStorage.inMemory({
            openai: { type: "api_key", key: "platform-key" },
          });
          return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
        },
      }),
      workspaceDir: agentDir,
      authModes: { openai: "api_key" as const },
      pluginRegistry,
    };
    vi.spyOn(webMedia, "loadWebMediaRaw").mockResolvedValue(FAKE_PDF_MEDIA);
    vi.spyOn(pdfExtract, "extractPdfContent").mockResolvedValue({ text: "PDF", images: [] });
    const complete = vi.spyOn(llmStream, "completeSimple").mockResolvedValue(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "PDF answer" }],
      }),
    );
    const tool =
      createPdfTool({ config, agentDir, preparedModelRuntime }) ??
      expect.fail("PDF tool was not registered");
    const result = await tool.execute("pdf-auth", { pdf: "/tmp/doc.pdf", pages: "21" });
    expect(result.content).toEqual([{ type: "text", text: "PDF answer" }]);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        id: modelId,
        api: oauth ? expect.stringContaining("openai-chatgpt-responses") : "openai-responses",
        baseUrl: oauth ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1",
      }),
      expect.anything(),
      expect.objectContaining({
        apiKey: oauth ? "access-token" : "platform-key",
      }),
      expect.any(Function),
    );
  });
});
