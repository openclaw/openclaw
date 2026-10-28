import { expect, type Mock, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as pdfExtract from "../../media/pdf-extract.js";
import * as webMedia from "../../media/web-media.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import * as authProfiles from "../auth-profiles.js";
import * as modelAuth from "../model-auth.js";
import * as preparedModelRuntime from "../prepared-model-runtime.js";
import {
  getModelRegistryRuntime,
  initializeModelRegistryRuntime,
} from "../sessions/model-registry-runtime.js";
import { createPdfTool } from "./pdf-tool.js";

export function requirePdfTool(options: Parameters<typeof createPdfTool>[0]) {
  return createPdfTool(options) ?? expect.fail("expected PDF tool");
}

export function stubPdfInput(text = "PDF") {
  vi.spyOn(webMedia, "loadWebMediaRaw").mockResolvedValue(FAKE_PDF_MEDIA);
  vi.spyOn(pdfExtract, "extractPdfContent").mockResolvedValue({ text, images: [] });
}

// Empty prepared facts leave model resolution to each fixture's registry.
export function withPreparedRuntimeFacts(snapshot: {
  agentDir: string;
  config: OpenClawConfig;
  workspaceDir?: string;
  createStores: () => { authStorage: unknown; modelRegistry: unknown };
}) {
  return {
    ...snapshot,
    metadataSnapshot: createEmptyPluginMetadataSnapshot(snapshot.workspaceDir),
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    modelCatalog: { entries: [], routeVariants: [] },
  };
}

export function withTempPdfAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  return withTempDir("openclaw-pdf-", run);
}

export function resetPdfToolAuthEnv(): void {
  const providers = ["OPENAI", "ANTHROPIC", "GEMINI", "GOOGLE", "MINIMAX", "ZAI", "Z_AI"];
  for (const provider of providers) {
    vi.stubEnv(`${provider}_API_KEY`, "");
  }
  vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
  vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
}

export const FAKE_PDF_MEDIA = {
  kind: "document",
  buffer: Buffer.from("%PDF-1.4 fake"),
  contentType: "application/pdf",
  fileName: "doc.pdf",
} as const;

export function createPdfToolInfraStub(completeMock: Mock) {
  function createPdfModelRegistry(find: (provider: string, modelId: string) => unknown) {
    const modelRegistry = { find, getProviderMetadataOwners: () => undefined };
    initializeModelRegistryRuntime(modelRegistry);
    getModelRegistryRuntime(modelRegistry).llmRuntime.completeSimple = completeMock;
    return modelRegistry;
  }

  async function stubPdfToolInfra(
    _agentDir: string,
    params: {
      mockLoad?: boolean;
      provider?: string;
      input?: string[];
      api?: string;
    } = {},
  ) {
    const { provider = "anthropic", input: modalities = ["text", "document"] } = params;
    if (provider === "openai") {
      vi.stubEnv("OPENAI_API_KEY", "test-key");
    }
    const loadSpy = vi.spyOn(webMedia, "loadWebMediaRaw");
    if (params.mockLoad !== false) {
      loadSpy.mockResolvedValue(FAKE_PDF_MEDIA);
    }

    const authStorage = { setRuntimeApiKey: vi.fn() };
    const model = {
      baseUrl: "https://pdf-fixture.invalid/v1",
      provider,
      api: params.api ?? (provider === "openai" ? "openai-responses" : "anthropic-messages"),
      maxTokens: 8192,
      input: modalities,
    };
    const modelRegistry = createPdfModelRegistry((_provider, id) => ({ id, name: id, ...model }));
    vi.spyOn(preparedModelRuntime, "acquireAgentRunPreparedModelRuntime").mockImplementation(
      async ({ agentDir: capturedAgentDir, config, workspaceDir }) =>
        ({
          snapshot: withPreparedRuntimeFacts({
            agentDir: capturedAgentDir,
            config,
            workspaceDir,
            createStores: () => ({ authStorage, modelRegistry }),
          }),
          [Symbol.asyncDispose]: async () => {},
        }) as never,
    );

    const profiles = vi.spyOn(authProfiles, "ensureAuthProfileStoreWithoutExternalProfilesAsync");
    profiles.mockResolvedValue({ version: 1, profiles: {} });

    const auth = vi.spyOn(modelAuth, "getApiKeyForModelCore");
    auth.mockResolvedValue({ apiKey: "test-key", mode: "api-key", source: "fixture" });
    vi.spyOn(modelAuth, "requireApiKey").mockReturnValue("test-key");

    return { loadSpy, setRuntimeApiKey: authStorage.setRuntimeApiKey };
  }

  return { createPdfModelRegistry, stubPdfToolInfra };
}
