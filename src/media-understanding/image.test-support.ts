import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { PreparedModelRuntimeLeaseOptions } from "../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { ImageDescriptionRequest } from "./types.js";

export const API_KEY_FIELD = ["api", "Key"].join("") as "apiKey";
const REQUIRE_API_KEY_FIELD = ["require", "ApiKey"].join("");
const SET_RUNTIME_API_KEY_FIELD = ["setRuntime", "ApiKey"].join("");

const imageRuntimeMocks = vi.hoisted(() => ({
  completeMock: vi.fn(),
  ensureOpenClawModelsJsonMock: vi.fn(async () => {}),
  getApiKeyForModelMock: vi.fn<
    () => Promise<{
      apiKey: string;
      source: string;
      mode: string;
      profileId?: string;
    }>
  >(),
  resolveApiKeyForProviderCoreMock: vi.fn<
    () => Promise<{
      apiKey: string;
      source: string;
      mode: string;
    }>
  >(),
  requireApiKeyMock: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
  setRuntimeApiKeyMock: vi.fn(),
  discoverModelsMock: vi.fn(),
  fetchMock: vi.fn(),
  registerProviderStreamForModelMock: vi.fn(),
  prepareProviderDynamicModelMock: vi.fn(async () => {}),
  prepareProviderRuntimeAuthMock: vi.fn(),
  acquireAgentRunPreparedModelRuntimeMock: vi.fn(),
  releasePreparedModelRuntimeMock: vi.fn(async () => {}),
  resolveModelAsyncMock: vi.fn(),
  resolveModelWithRegistryMock: vi.fn(),
  shouldPreferProviderRuntimeResolvedModelMock: vi.fn(() => false),
  unwrapSecretSentinelsForProviderEgressMock: vi.fn((value: string) => value),
}));
const m = imageRuntimeMocks;
export const preparedAuthStorage = { [SET_RUNTIME_API_KEY_FIELD]: m.setRuntimeApiKeyMock };

type ResolveModelWithRegistryTestParams = {
  modelRegistry: { find: (provider: string, modelId: string) => unknown };
  provider: string;
  modelId: string;
};

vi.mock("../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../llm/stream.js")>("../llm/stream.js");
  return {
    ...actual,
    complete: m.completeMock,
  };
});

vi.mock("../agents/models-config.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/models-config.js")>(
    "../agents/models-config.js",
  )),
  ensureOpenClawModelsJson: m.ensureOpenClawModelsJsonMock,
}));

vi.mock("../agents/model-auth.js", () => ({
  applySecretRefHeaderSentinels: (model: unknown) => model,
  getApiKeyForModelCore: m.getApiKeyForModelMock,
  resolveApiKeyForProviderCore: m.resolveApiKeyForProviderCoreMock,
  [REQUIRE_API_KEY_FIELD]: m.requireApiKeyMock,
}));

vi.mock("../agents/provider-stream.js", () => ({
  registerProviderStreamForModel: m.registerProviderStreamForModelMock,
}));

vi.mock("../agents/sessions/model-registry-runtime.js", () => ({
  getModelRegistryRuntime: () => ({ apiRegistry: {}, llmRuntime: {} }),
}));

vi.mock("../agents/provider-secret-egress.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/provider-secret-egress.js")>(
    "../agents/provider-secret-egress.js",
  )),
  unwrapSecretSentinelsForProviderEgress: m.unwrapSecretSentinelsForProviderEgressMock,
}));

// mock-isolation: Image fixtures supply credential setters and model results without opening real stores.
vi.mock("../agents/agent-model-discovery.js", () => ({
  discoverAuthStorage: () => ({ [SET_RUNTIME_API_KEY_FIELD]: m.setRuntimeApiKeyMock }),
  discoverModelsAsync: async (...args: Parameters<typeof m.discoverModelsMock>) =>
    m.discoverModelsMock(...args),
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: m.acquireAgentRunPreparedModelRuntimeMock,
}));

vi.mock("../plugins/provider-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  )),
  prepareProviderDynamicModel: m.prepareProviderDynamicModelMock,
  shouldPreferProviderRuntimeResolvedModel: m.shouldPreferProviderRuntimeResolvedModelMock,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: m.prepareProviderRuntimeAuthMock,
}));

vi.mock("../agents/embedded-agent-runner/model.js", () => ({
  resolveModelAsync: m.resolveModelAsyncMock,
}));

const imageTestFetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
vi.mock("../infra/net/fetch-guard.js", async () => {
  const mod = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...mod,
    fetchWithSsrFGuard: imageTestFetchWithSsrFGuardMock,
  };
});

export function installImageRuntimeTestHooks({
  apiKey = "test-token",
  copilotHeaders = {},
}: {
  apiKey?: string;
  copilotHeaders?: Record<string, string>;
} = {}) {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // Provider endpoint policy comes from manifests. Pin source manifests so a
    // prior local build cannot make this source-checkout test read partial dist output.
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
    vi.stubGlobal("fetch", m.fetchMock);
    for (const mock of Object.values(imageRuntimeMocks)) {
      mock.mockReset();
    }
    imageTestFetchWithSsrFGuardMock.mockReset();
    m.getApiKeyForModelMock.mockResolvedValue({ apiKey, source: "test", mode: "oauth" });
    m.resolveApiKeyForProviderCoreMock.mockResolvedValue({ apiKey, source: "test", mode: "oauth" });
    m.acquireAgentRunPreparedModelRuntimeMock.mockImplementation(
      async (
        input: { agentDir: string; config: OpenClawConfig; workspaceDir?: string },
        options?: PreparedModelRuntimeLeaseOptions,
      ) => {
        const metadataSnapshot = resolvePluginMetadataSnapshot({
          config: input.config,
          workspaceDir: input.workspaceDir,
        });
        options?.deriveRuntimePluginSelections?.({ config: input.config, metadataSnapshot });
        return {
          snapshot: {
            agentDir: input.agentDir,
            config: input.config,
            workspaceDir: input.workspaceDir,
            metadataSnapshot,
            createStores: () => ({
              authStorage: preparedAuthStorage,
              modelRegistry: {},
            }),
          },
          [Symbol.asyncDispose]: m.releasePreparedModelRuntimeMock,
        };
      },
    );
    m.fetchMock.mockImplementation(async () =>
      Response.json({
        base_resp: { status_code: 0 },
        content: "portal ok",
      }),
    );
    // Guarded requests must reach m.fetchMock for endpoint and payload assertions.
    imageTestFetchWithSsrFGuardMock.mockImplementation(
      async (opts: { url: string; init: RequestInit; timeoutMs?: number }) => {
        const signal = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
        const init = { ...opts.init, signal };
        const response = await globalThis.fetch(opts.url, init);
        return { response, release: vi.fn(), finalUrl: opts.url };
      },
    );
    m.discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "minimax-portal",
        id: "MiniMax-VL-01",
        input: ["text", "image"],
        baseUrl: "https://api.minimax.io/anthropic",
      })),
    });
    m.resolveModelWithRegistryMock.mockImplementation(
      // Per-case discovery overrides must reach model dispatch.
      ({ modelRegistry, provider, modelId }: ResolveModelWithRegistryTestParams) =>
        modelRegistry.find(provider, modelId),
    );
    m.resolveModelAsyncMock.mockImplementation(
      async (provider: string, modelId: string, agentDir?: string, cfg?: unknown) => {
        const authStorage = { [SET_RUNTIME_API_KEY_FIELD]: m.setRuntimeApiKeyMock };
        const modelRegistry = m.discoverModelsMock(authStorage, agentDir);
        const model = m.resolveModelWithRegistryMock({
          provider,
          modelId,
          modelRegistry,
          cfg,
          agentDir,
        });
        return { authStorage, model, modelRegistry };
      },
    );
    m.prepareProviderRuntimeAuthMock.mockImplementation(async (params: { provider: string }) => {
      return params.provider === "github-copilot"
        ? {
            [API_KEY_FIELD]: apiKey,
            baseUrl: "https://api.githubcopilot.com",
            request: {
              headers: {
                "Copilot-Integration-Id": "copilot-developer-cli",
                "Openai-Organization": "github-copilot",
                ...copilotHeaders,
              },
            },
          }
        : undefined;
    });
  });
}

export { imageRuntimeMocks, imageTestFetchWithSsrFGuardMock };

export function imageRequestDefaults(): Omit<ImageDescriptionRequest, "provider" | "model"> {
  return {
    cfg: {},
    agentDir: "/tmp/openclaw-agent",
    buffer: Buffer.from("png-bytes"),
    fileName: "image.png",
    mime: "image/png",
    timeoutMs: 1000,
  };
}

export function imageCompletion(api: string, provider: string, model: string, text: string) {
  return {
    role: "assistant",
    api,
    provider,
    model,
    stopReason: "stop",
    timestamp: Date.now(),
    content: [{ type: "text", text }],
  };
}

export function mockImageModel(model: Pick<Model, "provider" | "id"> & Partial<Model>) {
  m.discoverModelsMock.mockReturnValue({
    find: vi.fn(() => ({ input: ["text", "image"], ...model })),
  });
}
