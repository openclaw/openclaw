import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
import { createOAuthRefreshCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { persistAuthProfileBatch } from "../auth-profiles/upsert-with-lock.js";
import { createEmptyPreparedModelRuntimeFixture } from "../embedded-agent-runner/model.fixture.test-support.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
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

describe("Anthropic PDF model authentication routing", () => {
  it.each(["setup token", "API key"] as const)(
    "routes an Anthropic %s profile through the PDF tool to Messages",
    async (mode) => {
      resetPdfToolAuthEnv();
      await withTempPdfAgentDir(async (agentDir) => {
        const modelId = "claude-opus-4-6";
        const profileId = "anthropic:pdf-fixture";
        const credential =
          mode === "setup token"
            ? {
                type: "token" as const,
                provider: "anthropic" as const,
                token: "sk-ant-oat01-fixture-setup-token",
              }
            : {
                type: "api_key" as const,
                provider: "anthropic" as const,
                key: "fixture-anthropic-api-key",
              };
        await persistAuthProfileBatch({
          agentDir,
          profiles: [{ profileId, credential }],
        });

        const requests: Array<{
          authorizationIsSetupToken: boolean;
          xApiKeyIsControl: boolean;
          anthropicBeta: string;
          userAgentIsClaudeCode: boolean;
          documentCount: number;
          status: number;
        }> = [];
        const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            messages?: Array<{ content?: Array<{ type?: string }> }>;
          };
          const captured = {
            authorizationIsSetupToken:
              request.headers.authorization === "Bearer sk-ant-oat01-fixture-setup-token",
            xApiKeyIsControl: request.headers["x-api-key"] === "fixture-anthropic-api-key",
            anthropicBeta: request.headers["anthropic-beta"]?.toString() ?? "",
            userAgentIsClaudeCode: /^claude-cli\/\d+\.\d+\.\d+$/.test(
              request.headers["user-agent"]?.toString() ?? "",
            ),
            documentCount:
              body.messages?.[0]?.content?.filter((block) => block.type === "document").length ?? 0,
          };
          const betaHeaders = new Set(
            captured.anthropicBeta.split(",").map((value) => value.trim()),
          );
          const setupTokenAccepted =
            captured.authorizationIsSetupToken &&
            !request.headers["x-api-key"] &&
            captured.userAgentIsClaudeCode &&
            betaHeaders.has("claude-code-20250219") &&
            betaHeaders.has("oauth-2025-04-20") &&
            betaHeaders.has("pdfs-2024-09-25");
          const apiKeyAccepted =
            captured.xApiKeyIsControl &&
            !request.headers.authorization &&
            betaHeaders.has("pdfs-2024-09-25") &&
            !betaHeaders.has("oauth-2025-04-20");
          const status = setupTokenAccepted || apiKeyAccepted ? 200 : 401;
          requests.push({ ...captured, status });
          response.writeHead(status, { "content-type": "application/json" });
          response.end(
            JSON.stringify(
              status === 200
                ? { content: [{ type: "text", text: "PDF summary" }] }
                : { error: { message: "invalid authentication" } },
            ),
          );
        };
        const fixture = createServer((request, response) => {
          void handleRequest(request, response);
        });
        await new Promise<void>((resolve) => {
          fixture.listen(0, "127.0.0.1", () => resolve());
        });
        const address = fixture.address();
        if (!address || typeof address === "string") {
          throw new Error("loopback fixture did not bind to a TCP port");
        }

        try {
          const config: OpenClawConfig = {
            plugins: { entries: { anthropic: { enabled: true } } },
            auth: {
              profiles: {
                [profileId]: {
                  provider: "anthropic",
                  mode: mode === "setup token" ? "oauth" : "api_key",
                },
              },
              order: { anthropic: [profileId] },
            },
            models: {
              mode: "merge",
              providers: {
                anthropic: {
                  baseUrl: `http://127.0.0.1:${address.port}`,
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
            agents: {
              defaults: {
                model: { primary: `anthropic/${modelId}` },
                pdfModel: { primary: `anthropic/${modelId}` },
              },
            },
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
            catalogOwner: undefined,
            agentDir,
            workspaceDir: agentDir,
            activeProjectKeys: [],
            config,
            observationConfig: config,
            isCurrent: () => true,
            authModes: { anthropic: mode === "setup token" ? "oauth" : "api_key" },
            metadataSnapshot,
            pluginRegistry,
            allowGatewaySubagentBinding: false,
            modelCatalog: { entries: [], routeVariants: [] },
            configuredRuntimeModels: [],
            findConfiguredRuntimeModel: () => undefined,
            inlineProviderModels: [],
            createStores: () => {
              const authStorage = AuthStorage.inMemory();
              return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
            },
          } satisfies PreparedModelRuntimeSnapshot;

          vi.spyOn(webMedia, "loadWebMediaRaw").mockResolvedValue(FAKE_PDF_MEDIA);
          const tool = createPdfTool({ config, agentDir, preparedModelRuntime });
          if (!tool) {
            throw new Error("PDF tool was not registered");
          }
          const result = await tool.execute("pdf-auth", {
            pdf: "/tmp/doc.pdf",
            prompt: "Summarize this PDF.",
          });

          expect(result.content).toEqual([{ type: "text", text: "PDF summary" }]);
          expect(requests).toHaveLength(1);
          const request = requests[0];
          if (!request) {
            throw new Error("expected a captured Anthropic PDF request");
          }
          expect(request.documentCount).toBe(1);
          expect(request.userAgentIsClaudeCode).toBe(mode === "setup token");
          const betaHeaders = request.anthropicBeta.split(",").map((value) => value.trim());
          expect(betaHeaders).toContain("pdfs-2024-09-25");
          if (mode === "setup token") {
            expect(request.authorizationIsSetupToken).toBe(true);
            expect(request.xApiKeyIsControl).toBe(false);
            expect(betaHeaders).toEqual(
              expect.arrayContaining(["claude-code-20250219", "oauth-2025-04-20"]),
            );
          } else {
            expect(request.authorizationIsSetupToken).toBe(false);
            expect(request.xApiKeyIsControl).toBe(true);
            expect(betaHeaders).not.toContain("oauth-2025-04-20");
          }
        } finally {
          await new Promise<void>((resolve, reject) => {
            fixture.close((error) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          });
        }
      });
    },
  );
});
