import { type Mock, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as webMedia from "../../media/web-media.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import * as authProfiles from "../auth-profiles.js";
import * as modelAuth from "../model-auth.js";
import * as preparedModelRuntime from "../prepared-model-runtime.js";
import {
  getModelRegistryRuntime,
  initializeModelRegistryRuntime,
} from "../sessions/model-registry-runtime.js";

type StubPreparedRuntimeSnapshot = {
  agentDir: string;
  config: OpenClawConfig;
  workspaceDir?: string;
  pluginRegistry?: PluginRegistry;
  createStores: () => { authStorage: unknown; modelRegistry: unknown };
};

// Empty prepared facts leave model resolution to each fixture's registry.
export function withPreparedRuntimeFacts(snapshot: StubPreparedRuntimeSnapshot) {
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
      modelFound?: boolean;
      pluginRegistry?: PluginRegistry;
    } = {},
  ) {
    const {
      provider = "anthropic",
      input: modalities = ["text", "document"],
      pluginRegistry,
    } = params;
    if (provider === "openai") {
      vi.stubEnv("OPENAI_API_KEY", "test-key");
    }
    const loadSpy = vi.spyOn(webMedia, "loadWebMediaRaw");
    if (params.mockLoad !== false) {
      loadSpy.mockResolvedValue(FAKE_PDF_MEDIA);
    }

    const setRuntimeApiKey = vi.fn();
    const authStorage = { setRuntimeApiKey };
    const model = {
      baseUrl: "https://pdf-fixture.invalid/v1",
      provider,
      api: params.api ?? (provider === "openai" ? "openai-responses" : "anthropic-messages"),
      maxTokens: 8192,
      input: modalities,
    };
    const modelRegistry = createPdfModelRegistry((_provider, id) =>
      params.modelFound === false ? null : { id, name: id, ...model },
    );
    const createStores = () => ({ authStorage, modelRegistry });
    const release = vi.fn(async () => {});
    vi.spyOn(preparedModelRuntime, "acquireAgentRunPreparedModelRuntime").mockImplementation(
      async ({ agentDir: capturedAgentDir, config, workspaceDir }) =>
        ({
          snapshot: withPreparedRuntimeFacts({
            agentDir: capturedAgentDir,
            config,
            workspaceDir,
            pluginRegistry,
            createStores,
          }),
          [Symbol.asyncDispose]: release,
        }) as never,
    );

    const profiles = vi.spyOn(authProfiles, "ensureAuthProfileStoreWithoutExternalProfilesAsync");
    profiles.mockResolvedValue({ version: 1, profiles: {} });

    const auth = vi.spyOn(modelAuth, "getApiKeyForModelCore");
    auth.mockResolvedValue({ apiKey: "test-key", mode: "api-key", source: "fixture" });
    vi.spyOn(modelAuth, "requireApiKey").mockReturnValue("test-key");

    return { loadSpy, release, setRuntimeApiKey };
  }

  return { createPdfModelRegistry, stubPdfToolInfra };
}
