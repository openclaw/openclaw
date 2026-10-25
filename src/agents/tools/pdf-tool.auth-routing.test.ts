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

it.each(["setup token", "provider-default setup token", "API key"] as const)(
  "routes an Anthropic %s profile through the PDF tool to Messages",
  async (mode) => {
    resetPdfToolAuthEnv();
    await withTempPdfAgentDir(async (agentDir) => {
      const modelId = "claude-opus-4-6";
      const profileId = "anthropic:pdf-fixture";
      const oauth = mode !== "API key";
      await persistAuthProfileBatch({
        agentDir,
        profiles: [
          {
            profileId,
            credential: oauth
              ? { type: "token", provider: "anthropic", token: "sk-ant-oat01-fixture-setup-token" }
              : { type: "api_key", provider: "anthropic", key: "fixture-anthropic-api-key" },
          },
        ],
      });
      const model = { primary: `anthropic/${modelId}` };
      const config: OpenClawConfig = {
        plugins: { entries: { anthropic: { enabled: true } } },
        auth: {
          profiles: { [profileId]: { provider: "anthropic", mode: oauth ? "token" : "api_key" } },
          order: { anthropic: [profileId] },
        },
        models: {
          providers: {
            anthropic: {
              baseUrl: "http://127.0.0.1:12345",
              ...(mode === "provider-default setup token"
                ? { request: { auth: { mode: "provider-default" } } }
                : {}),
              models: [
                {
                  id: modelId,
                  name: modelId,
                  input: ["text"],
                  reasoning: true,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
        agents: { defaults: { model, pdfModel: model } },
      };
      const { buildAnthropicProvider } = await loadBundledPluginFacade<{
        buildAnthropicProvider: () => ProviderPlugin;
      }>({ pluginId: "anthropic", artifactBasename: "api.js" });
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.providers.push({
        pluginId: "anthropic",
        source: path.resolve("extensions/anthropic/index.ts"),
        provider: buildAnthropicProvider(),
      });
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "anthropic", providers: ["anthropic"], enabledByDefault: true }],
      });
      const preparedModelRuntime = {
        ...createEmptyPreparedModelRuntimeFixture({
          agentDir,
          config,
          metadataSnapshot,
          createStores: () => {
            const authStorage = AuthStorage.inMemory();
            return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
          },
        }),
        workspaceDir: agentDir,
        authModes: { anthropic: oauth ? ("token" as const) : ("api_key" as const) },
        pluginRegistry,
      };
      vi.spyOn(webMedia, "loadWebMediaRaw").mockResolvedValue(FAKE_PDF_MEDIA);
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json({ content: [{ type: "text", text: "PDF summary" }] }));
      const tool =
        createPdfTool({ config, agentDir, preparedModelRuntime }) ??
        expect.fail("PDF tool was not registered");
      const result = await tool.execute("pdf-auth", {
        pdf: "/tmp/doc.pdf",
        prompt: "Summarize this PDF.",
      });
      expect(result.content).toEqual([{ type: "text", text: "PDF summary" }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] ?? expect.fail("Expected a PDF request");
      expect(url).toBe("http://127.0.0.1:12345/v1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(
        oauth ? "Bearer sk-ant-oat01-fixture-setup-token" : null,
      );
      expect(headers.get("x-api-key")).toBe(oauth ? null : "fixture-anthropic-api-key");
      expect(headers.get("anthropic-beta")?.split(",")).toEqual(
        oauth
          ? expect.arrayContaining(["pdfs-2024-09-25", "claude-code-20250219", "oauth-2025-04-20"])
          : ["pdfs-2024-09-25"],
      );
      if (oauth) {
        expect(headers.get("user-agent")).toMatch(/^claude-cli\/\d+\.\d+\.\d+$/);
        expect(headers.get("x-app")).toBe("cli");
      }
      const requestBody = init?.body;
      if (typeof requestBody !== "string") {
        expect.fail("Expected a serialized PDF request body");
      }
      const body = JSON.parse(requestBody);
      expect(body.system).toEqual(
        oauth
          ? [
              {
                type: "text",
                text: expect.stringMatching(
                  /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+; cc_entrypoint=sdk-cli;$/,
                ),
              },
              { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
            ]
          : undefined,
      );
      expect(body).toMatchObject({
        model: modelId,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  media_type: "application/pdf",
                  data: FAKE_PDF_MEDIA.buffer.toString("base64"),
                },
              },
              { type: "text", text: "Summarize this PDF." },
            ],
          },
        ],
      });
    });
  },
);
