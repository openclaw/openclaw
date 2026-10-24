import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { discoverOpenAICompatibleLocalModels } from "./provider-self-hosted-discovery.js";
import { configureOpenAICompatibleSelfHostedProviderNonInteractive } from "./provider-self-hosted-setup.js";
import type { ProviderAuthMethodNonInteractiveContext } from "./types.js";

const { fetchWithSsrFGuardMock, upsertAuthProfileWithLockOrThrow, loggerWarnMock } = vi.hoisted(
  () => ({
    fetchWithSsrFGuardMock: vi.fn(),
    upsertAuthProfileWithLockOrThrow: vi.fn(async () => undefined),
    loggerWarnMock: vi.fn(),
  }),
);

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../agents/auth-profiles/upsert-with-lock.js", () => ({
  upsertAuthProfileWithLockOrThrow,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: loggerWarnMock }),
}));

beforeEach(() => vi.clearAllMocks());

// Mirrors SELF_HOSTED_DISCOVERY_JSON_MAX_BYTES in the source under test. Kept in
// sync deliberately so the regression asserts the body is capped, not drained.
const SELF_HOSTED_DISCOVERY_JSON_MAX_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

function createUnboundedJsonStream() {
  const state = { cancelCount: 0, bytesPulled: 0 };
  const chunk = new Uint8Array(CHUNK_BYTES).fill(0x20); // ASCII spaces: valid stream, never closes
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.bytesPulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelCount += 1;
    },
  });
  return { body, state };
}

function createContext(
  overrides: {
    providerId?: string;
    baseUrl?: string;
    apiKey?: string;
    modelId?: string;
  } = {},
): ProviderAuthMethodNonInteractiveContext {
  const params = { providerId: "vllm", modelId: "Qwen/Qwen3-32B", ...overrides };
  const resolved = {
    key: params.apiKey ?? "self-hosted-test-key",
    source: "flag" as const,
  };
  return {
    authChoice: params.providerId,
    config: { agents: { defaults: {} } },
    baseConfig: { agents: { defaults: {} } },
    opts: {
      customBaseUrl: params.baseUrl,
      customApiKey: params.apiKey,
      customModelId: params.modelId,
    },
    runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() } as never,
    agentDir: "/tmp/openclaw-self-hosted-test-agent",
    resolveApiKey: vi.fn<ProviderAuthMethodNonInteractiveContext["resolveApiKey"]>(
      async () => resolved,
    ),
    toApiKeyCredential: vi.fn<ProviderAuthMethodNonInteractiveContext["toApiKeyCredential"]>(
      ({ provider, resolved: apiKeyResult }) => ({
        type: "api_key",
        provider,
        key: apiKeyResult.key,
      }),
    ),
  };
}

function refuseCredential(ctx: ProviderAuthMethodNonInteractiveContext, message: string) {
  vi.mocked(ctx.toApiKeyCredential).mockImplementationOnce(() => {
    ctx.runtime.error(message);
    ctx.runtime.exit(1);
    return null;
  });
}

function expectNoCredentialWrites(ctx: ProviderAuthMethodNonInteractiveContext) {
  expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
  expect(upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
  expect(ctx.runtime.error).not.toHaveBeenCalled();
  expect(ctx.runtime.exit).not.toHaveBeenCalled();
}

function expectedModel(
  id: string,
  overrides: Partial<ModelDefinitionConfig> = {},
): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    ...overrides,
  };
}

function readPrimaryModel(config: Awaited<ReturnType<typeof configureSelfHostedTestProvider>>) {
  const model = config?.agents?.defaults?.model;
  return model && typeof model === "object" ? model.primary : undefined;
}

async function configureSelfHostedTestProvider(params: {
  ctx: ProviderAuthMethodNonInteractiveContext;
  providerId?: string;
  providerLabel?: string;
  envVar?: string;
}) {
  return await configureOpenAICompatibleSelfHostedProviderNonInteractive({
    ctx: params.ctx,
    providerId: params.providerId ?? "vllm",
    providerLabel: params.providerLabel ?? "vLLM",
    defaultBaseUrl: "http://127.0.0.1:8000/v1",
    defaultApiKeyEnvVar: params.envVar ?? "VLLM_API_KEY",
    modelPlaceholder: "Qwen/Qwen3-32B",
  });
}

function cancelTrackedResponse(init?: ResponseInit) {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("ignored"));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

function queueResponse(response: Response, finalUrl: string) {
  const release = vi.fn(async () => undefined);
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, finalUrl, release });
  return release;
}

function queueJsonResponse(body: unknown, finalUrl: string) {
  return queueResponse(new Response(JSON.stringify(body), { status: 200 }), finalUrl);
}

const vllmUrl = "http://127.0.0.1:8000/v1";
const llamaUrl = "http://127.0.0.1:8080/v1";
const vllm = { providerId: "vllm", providerLabel: "vLLM", envVar: "VLLM_API_KEY" };
const lmstudio = { providerId: "lmstudio", providerLabel: "LM Studio", envVar: "LM_API_TOKEN" };
function queueCatalog(data: unknown[], baseUrl = vllmUrl) {
  return queueJsonResponse({ data }, `${baseUrl}/models`);
}
function queueProps(body: unknown, query = "") {
  return queueJsonResponse(body, `http://127.0.0.1:8080/props${query}`);
}
function expectRequest(index: number, url: string, headers?: Record<string, string>) {
  expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
    index,
    expect.objectContaining({
      url,
      init: { headers },
      policy: { allowedOrigins: [new URL(url).origin] },
      timeoutMs: index === 1 ? 5000 : 2500,
    }),
  );
}
function expectReleased(...releases: ReturnType<typeof vi.fn>[]) {
  for (const release of releases) {
    expect(release).toHaveBeenCalledOnce();
  }
}

function discoverModels(
  label: string,
  baseUrl: string,
  options: Omit<
    Parameters<typeof discoverOpenAICompatibleLocalModels>[0],
    "label" | "baseUrl" | "env"
  > = {},
) {
  return discoverOpenAICompatibleLocalModels({ baseUrl, label, env: {}, ...options });
}

describe("discoverOpenAICompatibleLocalModels", () => {
  it("retains valid models when a provider catalog contains malformed entries", async () => {
    const release = queueJsonResponse(
      {
        data: [
          { id: "valid-a", meta: { n_ctx_train: 32_768 } },
          null,
          7,
          "invalid",
          [],
          { id: "valid-b", context_length: 65_536, context_window: 32_768, context_size: 16_384 },
        ],
      },
      "http://127.0.0.1:8000/v1/models",
    );

    const models = await discoverModels("vLLM", "http://127.0.0.1:8000/v1", {
      discoverRuntimeContext: false,
    });

    expect(models).toMatchObject([
      { id: "valid-a", contextWindow: 32_768 },
      { id: "valid-b", contextWindow: 65_536 },
    ]);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["non-array catalog", JSON.stringify({ data: {} })],
    ["malformed JSON", "not valid json {"],
    [
      "invalid UTF-8",
      new Uint8Array([
        ...new TextEncoder().encode('{"data":[{"id":"qwen3-'),
        0xff,
        ...new TextEncoder().encode('"}]}'),
      ]),
    ],
  ] as const)("warns and rejects %s", async (_kind, body) => {
    const release = queueResponse(new Response(body), `${llamaUrl}/models`);
    await expect(discoverModels("local llama.cpp", llamaUrl)).resolves.toEqual([]);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("local llama.cpp discovery: malformed JSON response"),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses guarded fetch pinned to the configured self-hosted provider", async () => {
    const propsResponse = cancelTrackedResponse({ status: 404 });
    const release = queueCatalog([{ id: "Qwen/Qwen3-32B" }]);
    const propsRelease = queueResponse(propsResponse.response, "http://127.0.0.1:8000/props");

    const models = await discoverModels("vLLM", "http://127.0.0.1:8000/v1/", {
      apiKey: "self-hosted-test-key",
    });

    expect(models).toEqual([expectedModel("Qwen/Qwen3-32B")]);
    expectRequest(1, "http://127.0.0.1:8000/v1/models", {
      Authorization: "Bearer self-hosted-test-key",
    });
    expectRequest(2, "http://127.0.0.1:8000/props", {
      Authorization: "Bearer self-hosted-test-key",
    });
    expectReleased(release, propsRelease);
    expect(propsResponse.wasCanceled()).toBe(true);
  });

  it("cancels model discovery error bodies before falling back", async () => {
    const response = cancelTrackedResponse({ status: 503, statusText: "Service Unavailable" });
    const release = queueResponse(response.response, "http://127.0.0.1:8000/v1/models");

    const models = await discoverModels("vLLM", "http://127.0.0.1:8000/v1/", {
      apiKey: "self-hosted-test-key",
    });

    expect(models).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
    expect(response.wasCanceled()).toBe(true);
  });

  it.each([
    ["nested", { default_generation_settings: { n_ctx: 65_536 } }],
    ["top-level compatibility", { n_ctx: 65_536 }],
  ])("uses llama.cpp %s /props n_ctx as the runtime context cap", async (_kind, props) => {
    const modelsRelease = queueCatalog(
      [{ id: "qwen3.6-mxfp4-moe", meta: { n_ctx_train: 262_144 } }],
      llamaUrl,
    );
    const propsRelease = queueProps(props);

    const models = await discoverModels("llama.cpp", "http://127.0.0.1:8080/v1");

    expect(models).toEqual([
      expectedModel("qwen3.6-mxfp4-moe", { contextWindow: 262_144, contextTokens: 65_536 }),
    ]);
    expectRequest(2, "http://127.0.0.1:8080/props");
    expectReleased(modelsRelease, propsRelease);
  });

  it("scopes llama.cpp /props runtime caps to each discovered model without autoloading", async () => {
    const modelsRelease = queueCatalog(
      [
        { id: "qwen/router-a", meta: { n_ctx_train: 262_144 } },
        { id: "qwen/router-b", meta: { n_ctx_train: 131_072 } },
      ],
      llamaUrl,
    );
    const firstPropsRelease = queueProps(
      { default_generation_settings: { n_ctx: 65_536 } },
      "?model=qwen%2Frouter-a&autoload=false",
    );
    const secondPropsRelease = queueProps(
      { default_generation_settings: { n_ctx: 32_768 } },
      "?model=qwen%2Frouter-b&autoload=false",
    );

    const models = await discoverModels("llama.cpp", "http://127.0.0.1:8080/v1");

    expect(models).toEqual([
      expectedModel("qwen/router-a", { contextWindow: 262_144, contextTokens: 65_536 }),
      expectedModel("qwen/router-b", { contextWindow: 131_072, contextTokens: 32_768 }),
    ]);
    expectRequest(2, "http://127.0.0.1:8080/props?model=qwen%2Frouter-a&autoload=false");
    expectRequest(3, "http://127.0.0.1:8080/props?model=qwen%2Frouter-b&autoload=false");
    expectReleased(modelsRelease, firstPropsRelease, secondPropsRelease);
  });

  it("preserves explicit configured context windows ahead of llama.cpp /props", async () => {
    const release = queueCatalog(
      [{ id: "qwen3.6-mxfp4-moe", meta: { n_ctx_train: 262_144 } }],
      llamaUrl,
    );

    const models = await discoverModels("llama.cpp", "http://127.0.0.1:8080/v1", {
      contextWindow: 65_536,
    });

    expect(models).toEqual([expectedModel("qwen3.6-mxfp4-moe", { contextWindow: 65_536 })]);
    expect(models[0]).not.toHaveProperty("contextTokens");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["models", "props"] as const)(
    "bounds an unbounded /%s discovery stream",
    async (endpoint) => {
      const oversized = createUnboundedJsonStream();
      const releases =
        endpoint === "props" ? [queueCatalog([{ id: "qwen3.6-mxfp4-moe" }], llamaUrl)] : [];
      releases.push(
        queueResponse(
          new Response(oversized.body),
          endpoint === "props" ? "http://127.0.0.1:8080/props" : `${vllmUrl}/models`,
        ),
      );
      const models = await discoverModels(
        endpoint === "props" ? "llama.cpp" : "vLLM",
        endpoint === "props" ? llamaUrl : vllmUrl,
      );
      // A model overflow rejects discovery; a props overflow preserves the catalog.
      expect(models).toEqual(endpoint === "props" ? [expectedModel("qwen3.6-mxfp4-moe")] : []);
      expect(oversized.state.cancelCount).toBe(1);
      expect(oversized.state.bytesPulled).toBeLessThanOrEqual(
        SELF_HOSTED_DISCOVERY_JSON_MAX_BYTES + 2 * CHUNK_BYTES,
      );
      expectReleased(...releases);
    },
  );
});

describe("configureOpenAICompatibleSelfHostedProviderNonInteractive", () => {
  it("stops setup when the auth profile cannot be persisted", async () => {
    const ctx = createContext();
    const configBefore = structuredClone(ctx.config);
    const failure = new Error("Auth profile store is unavailable.");
    upsertAuthProfileWithLockOrThrow.mockRejectedValueOnce(failure);

    await expect(configureSelfHostedTestProvider({ ctx })).rejects.toBe(failure);
    expect(ctx.config).toEqual(configBefore);
    expect(ctx.runtime.log).not.toHaveBeenCalled();
  });

  it("configures provider config and auth profile", async () => {
    const params = {
      ...vllm,
      baseUrl: "http://127.0.0.1:8100/v1/",
      apiKey: "vllm-test-key",
      modelId: "Qwen/Qwen3-8B",
    };
    const ctx = createContext(params);

    const cfg = await configureSelfHostedTestProvider({ ctx, ...params });

    const profileId = `${params.providerId}:default`;
    expect(cfg?.auth?.profiles?.[profileId]).toEqual({
      provider: params.providerId,
      mode: "api_key",
    });
    expect(cfg?.models?.providers?.[params.providerId]).toEqual({
      baseUrl: params.baseUrl.replace(/\/+$/, ""),
      api: "openai-completions",
      apiKey: params.envVar,
      models: [expectedModel(params.modelId)],
    });
    expect(readPrimaryModel(cfg)).toBe(`${params.providerId}/${params.modelId}`);
    expect(upsertAuthProfileWithLockOrThrow).toHaveBeenCalledWith({
      profileId,
      agentDir: ctx.agentDir,
      credential: {
        type: "api_key",
        provider: params.providerId,
        key: params.apiKey,
      },
    });
  });

  it("reuses an existing provider auth profile in ref mode", async () => {
    const params = vllm;
    const modelId = "Qwen/Qwen3-32B";
    const profileSecret = "fixture-existing-self-hosted-profile-secret";
    const selectedProfileId = `${params.providerId}:owner@example.com`;
    const backupProfileId = `${params.providerId}:backup`;
    const ctx = createContext({ providerId: params.providerId, modelId });
    ctx.opts.secretInputMode = "ref";
    const existingAuth = {
      profiles: {
        [selectedProfileId]: {
          provider: params.providerId,
          mode: "api_key" as const,
          email: "owner@example.com",
          displayName: "Operator Account",
        },
        [backupProfileId]: { provider: params.providerId, mode: "api_key" as const },
      },
      order: { [params.providerId]: [selectedProfileId, backupProfileId] },
    };
    ctx.config = { ...ctx.config, auth: existingAuth };
    vi.mocked(ctx.resolveApiKey).mockResolvedValueOnce({
      key: profileSecret,
      source: "profile",
    });
    refuseCredential(ctx, "Cannot encode an existing profile as a SecretRef.");

    const cfg = await configureSelfHostedTestProvider({ ctx, ...params });

    expect(cfg?.auth).toEqual(existingAuth);
    expect(cfg?.auth?.profiles?.[`${params.providerId}:default`]).toBeUndefined();
    expect(readPrimaryModel(cfg)).toBe(`${params.providerId}/${modelId}`);
    expect(JSON.stringify(cfg)).not.toContain(profileSecret);
    expectNoCredentialWrites(ctx);
  });

  it.each([
    { ...lmstudio, marker: "custom-local" },
    { ...lmstudio, marker: "lmstudio-local" },
  ])("keeps the $providerLabel non-secret marker keyless in ref mode", async (params) => {
    const modelId = "Qwen/Qwen3-32B";
    const ctx = createContext({ providerId: params.providerId, modelId });
    ctx.opts.secretInputMode = "ref";
    vi.mocked(ctx.resolveApiKey).mockResolvedValueOnce({ key: params.marker, source: "flag" });
    refuseCredential(ctx, "A synthetic non-secret marker must not become an auth credential.");

    const cfg = await configureSelfHostedTestProvider({ ctx, ...params });

    expect(readPrimaryModel(cfg)).toBe(`${params.providerId}/${modelId}`);
    expect(cfg?.auth?.profiles?.[`${params.providerId}:default`]).toBeUndefined();
    expectNoCredentialWrites(ctx);
  });

  it.each([
    { ...vllm, key: "custom-local" },
    { ...vllm, key: "lmstudio-local" },
    { ...lmstudio, key: "ollama-local" },
    { ...lmstudio, key: "oauth:lmstudio" },
    { ...lmstudio, key: "secretref-env:LM_API_TOKEN" },
    { ...vllm, key: "fixture-genuine-self-hosted-secret" },
    { ...vllm, key: "OPENAI_API_KEY" },
  ])(
    "rejects unowned marker or genuine flag value $key for $providerLabel in ref mode",
    async ({ key, ...params }) => {
      const ctx = createContext({ providerId: params.providerId, modelId: "Qwen/Qwen3-32B" });
      ctx.opts.secretInputMode = "ref";
      vi.mocked(ctx.resolveApiKey).mockResolvedValueOnce({ key, source: "flag" });
      refuseCredential(ctx, "SecretRef mode requires an explicit environment variable.");

      const cfg = await configureSelfHostedTestProvider({ ctx, ...params });

      expect(cfg).toBeNull();
      expect(ctx.toApiKeyCredential).toHaveBeenCalledOnce();
      expect(upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
      expect(ctx.runtime.error).toHaveBeenCalledOnce();
      expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
    },
  );

  it("does not treat another provider's marker as keyless in plaintext mode", async () => {
    const ctx = createContext();
    ctx.opts.secretInputMode = "plaintext";
    vi.mocked(ctx.resolveApiKey).mockResolvedValueOnce({ key: "lmstudio-local", source: "flag" });

    const cfg = await configureSelfHostedTestProvider({ ctx });

    expect(ctx.toApiKeyCredential).toHaveBeenCalledOnce();
    expect(upsertAuthProfileWithLockOrThrow).toHaveBeenCalledWith({
      profileId: "vllm:default",
      agentDir: ctx.agentDir,
      credential: { type: "api_key", provider: "vllm", key: "lmstudio-local" },
    });
    expect(cfg?.auth?.profiles?.["vllm:default"]).toEqual({
      provider: "vllm",
      mode: "api_key",
    });
  });

  it("preserves an environment SecretRef when persisting a new auth profile", async () => {
    const ctx = createContext();
    ctx.opts.secretInputMode = "ref";
    vi.mocked(ctx.resolveApiKey).mockResolvedValueOnce({
      key: "fixture-existing-environment-secret",
      source: "env",
      envVarName: "VLLM_API_KEY",
    });
    const credential = {
      type: "api_key" as const,
      provider: "vllm",
      keyRef: { source: "env" as const, provider: "default", id: "VLLM_API_KEY" },
    };
    vi.mocked(ctx.toApiKeyCredential).mockReturnValueOnce(credential);

    const cfg = await configureSelfHostedTestProvider({ ctx });

    expect(upsertAuthProfileWithLockOrThrow).toHaveBeenCalledWith({
      profileId: "vllm:default",
      agentDir: ctx.agentDir,
      credential,
    });
    expect(JSON.stringify(cfg)).not.toContain("fixture-existing-environment-secret");
  });

  it("does not write an auth profile when no usable credential is available", async () => {
    const ctx = createContext();
    vi.mocked(ctx.resolveApiKey).mockResolvedValueOnce(null);

    const cfg = await configureSelfHostedTestProvider({ ctx });

    expect(cfg).toBeNull();
    expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
    expect(upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
  });

  it("exits without touching auth when custom model id is missing", async () => {
    const ctx = createContext({
      modelId: undefined,
      apiKey: "vllm-test-key",
    });

    const cfg = await configureSelfHostedTestProvider({ ctx });

    expect(cfg).toBeNull();
    expect(ctx.runtime.error).toHaveBeenCalledWith(expect.stringContaining("--custom-model-id"));
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
    expect(ctx.resolveApiKey).not.toHaveBeenCalled();
    expect(upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
  });
});
