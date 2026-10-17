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

type FixtureAuth = { apiKey: string; source: string; mode: string; profileId?: string };

const imageRuntimeMocks = vi.hoisted(() => ({
  completeMock: vi.fn(),
  ensureOpenClawModelsJsonMock: vi.fn(async () => {}),
  getApiKeyForModelMock: vi.fn<() => Promise<FixtureAuth>>(),
  resolveApiKeyForProviderCoreMock: vi.fn<() => Promise<Omit<FixtureAuth, "profileId">>>(),
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
  shouldPreferProviderRuntimeResolvedModelMock: vi.fn(() => false),
  unwrapSecretSentinelsForProviderEgressMock: vi.fn((value: string) => value),
}));
const m = imageRuntimeMocks;
export const preparedAuthStorage = { [SET_RUNTIME_API_KEY_FIELD]: m.setRuntimeApiKeyMock };

vi.mock("../llm/stream.js", async (original) => ({
  ...(await original<typeof import("../llm/stream.js")>()),
  complete: m.completeMock,
}));

vi.mock("../agents/models-config.js", async (original) => ({
  ...(await original<typeof import("../agents/models-config.js")>()),
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

vi.mock("../agents/provider-secret-egress.js", async (original) => ({
  ...(await original<typeof import("../agents/provider-secret-egress.js")>()),
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

vi.mock("../plugins/provider-runtime.js", async (original) => ({
  ...(await original<typeof import("../plugins/provider-runtime.js")>()),
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
vi.mock("../infra/net/fetch-guard.js", async (original) => ({
  ...(await original<typeof import("../infra/net/fetch-guard.js")>()),
  fetchWithSsrFGuard: imageTestFetchWithSsrFGuardMock,
}));

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
    // Pin source manifests; partial local dist builds must not change endpoint policy.
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
            createStores: () => ({ authStorage: preparedAuthStorage, modelRegistry: {} }),
          },
          [Symbol.asyncDispose]: m.releasePreparedModelRuntimeMock,
        };
      },
    );
    m.fetchMock.mockImplementation(async () =>
      Response.json({ base_resp: { status_code: 0 }, content: "portal ok" }),
    );
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
    m.resolveModelAsyncMock.mockImplementation(
      async (provider: string, modelId: string, agentDir?: string) => {
        const authStorage = { [SET_RUNTIME_API_KEY_FIELD]: m.setRuntimeApiKeyMock };
        const modelRegistry = m.discoverModelsMock(authStorage, agentDir);
        const model = modelRegistry.find(provider, modelId);
        return { authStorage, model, modelRegistry };
      },
    );
    m.prepareProviderRuntimeAuthMock.mockImplementation(async (params: { provider: string }) =>
      params.provider === "github-copilot"
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
        : undefined,
    );
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
