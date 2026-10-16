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

beforeEach(() => {
  vi.clearAllMocks();
});

// Independent cap expectation: discovery must cancel rather than drain the body.
const SELF_HOSTED_DISCOVERY_JSON_MAX_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

// Never ends: only the production byte cap can stop this stream.
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
  return Object.assign(state, { body });
}

function createContext(params: {
  providerId: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
}): ProviderAuthMethodNonInteractiveContext {
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
    resolveApiKey: vi.fn<ProviderAuthMethodNonInteractiveContext["resolveApiKey"]>(async () => ({
      key: params.apiKey ?? "self-hosted-test-key",
      source: "flag" as const,
    })),
    toApiKeyCredential: vi.fn<ProviderAuthMethodNonInteractiveContext["toApiKeyCredential"]>(
      ({ provider, resolved: apiKeyResult }) => ({
        type: "api_key",
        provider,
        key: apiKeyResult.key,
      }),
    ),
  };
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

function rejectCredential(ctx: ProviderAuthMethodNonInteractiveContext, message: string) {
  vi.mocked(ctx.toApiKeyCredential).mockImplementationOnce(() => {
    ctx.runtime.error(message);
    ctx.runtime.exit(1);
    return null;
  });
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

function queueResponse(response: Response, finalUrl = "http://127.0.0.1:8000/v1/models") {
  const release = vi.fn(async () => undefined);
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, finalUrl, release });
  return release;
}

function queueJson(body: unknown, finalUrl?: string) {
  return queueResponse(new Response(JSON.stringify(body), { status: 200 }), finalUrl);
}

function expectGuardedFetch(
  call: number,
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
) {
  expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
    call,
    expect.objectContaining({
      url,
      init: { headers },
      policy: { allowedOrigins: [new URL(url).origin] },
      timeoutMs,
    }),
  );
}

const providers = {
  vllm: { providerId: "vllm", providerLabel: "vLLM", envVar: "VLLM_API_KEY" },
  lmstudio: { providerId: "lmstudio", providerLabel: "LM Studio", envVar: "LM_API_TOKEN" },
};

function discover(
  overrides: Partial<Parameters<typeof discoverOpenAICompatibleLocalModels>[0]> = {},
) {
  return discoverOpenAICompatibleLocalModels({
    baseUrl: "http://127.0.0.1:8000/v1",
    label: "vLLM",
    env: {},
    ...overrides,
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

async function discoverSingleCatalogModel(
  row: Record<string, unknown>,
  options?: { contextWindow?: number },
) {
  const release = vi.fn(async () => undefined);
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: new Response(JSON.stringify({ data: [row] }), { status: 200 }),
    finalUrl: "https://provider.example/v1/models",
    release,
  });

  const models = await discoverOpenAICompatibleLocalModels({
    baseUrl: "https://provider.example/v1",
    label: "custom provider",
    contextWindow: options?.contextWindow,
    discoverRuntimeContext: false,
    env: {},
  });

  expect(release).toHaveBeenCalledOnce();
  return models[0];
}

describe("discoverOpenAICompatibleLocalModels", () => {
  it("retains valid models when a provider catalog contains malformed entries", async () => {
    const release = queueJson({
      data: [
        { id: "valid-a", meta: { n_ctx_train: 32_768 } },
        null,
        7,
        "invalid",
        [],
        { id: "valid-b", meta: { n_ctx_train: 65_536 } },
      ],
    });
    const models = await discover({ discoverRuntimeContext: false });

    expect(models).toMatchObject([
      { id: "valid-a", contextWindow: 32_768 },
      { id: "valid-b", contextWindow: 65_536 },
    ]);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects a non-array model catalog", async () => {
    const release = queueJson({ data: {} });
    await expect(discover({ discoverRuntimeContext: false })).resolves.toEqual([]);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("vLLM discovery: malformed JSON response"),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds concurrent llama.cpp runtime probes without truncating its model catalog", async () => {
    const release = vi.fn(async () => undefined);
    const data = Array.from({ length: 201 }, (_, index) => ({
      id: `local/model-${index}`,
      meta: { n_ctx_train: 32_768 },
    }));
    let activePropsRequests = 0;
    let maximumPropsRequests = 0;
    fetchWithSsrFGuardMock.mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith("/models")) {
        return {
          response: new Response(JSON.stringify({ data }), { status: 200 }),
          finalUrl: url,
          release,
        };
      }
      activePropsRequests += 1;
      maximumPropsRequests = Math.max(maximumPropsRequests, activePropsRequests);
      await Promise.resolve();
      activePropsRequests -= 1;
      return {
        response: new Response(JSON.stringify({ default_generation_settings: { n_ctx: 16_384 } }), {
          status: 200,
        }),
        finalUrl: url,
        release,
      };
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama.cpp",
      env: {},
    });

    expect(models).toHaveLength(201);
    expect(models[0]).toMatchObject({ id: "local/model-0", contextTokens: 16_384 });
    expect(models[199]).toMatchObject({ id: "local/model-199", contextTokens: 16_384 });
    expect(models[200]).toMatchObject({ id: "local/model-200", contextWindow: 32_768 });
    expect(models[200]).not.toHaveProperty("contextTokens");
    expect(maximumPropsRequests).toBeLessThanOrEqual(8);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(201);
    expect(release).toHaveBeenCalledTimes(201);
  });

  it("discovers a large non-llama.cpp catalog without probing per-model llama.cpp props", async () => {
    const release = vi.fn(async () => undefined);
    const data = Array.from({ length: 500 }, (_, index) => ({
      id: `Qwen/model-${index}`,
      meta: { n_ctx_train: 32_768 },
    }));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ data }), { status: 200 }),
      finalUrl: "http://127.0.0.1:8000/v1/models",
      release,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8000/v1",
      label: "vLLM",
      discoverRuntimeContext: false,
      env: {},
    });

    expect(models).toHaveLength(500);
    expect(models[0]).toMatchObject({ id: "Qwen/model-0", contextWindow: 32_768 });
    expect(models[499]).toMatchObject({ id: "Qwen/model-499", contextWindow: 32_768 });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("labels malformed discovery JSON in the warning", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response("not valid json {", { status: 200 }),
      finalUrl: "http://127.0.0.1:8080/v1/models",
      release,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "local llama.cpp",
      env: {},
    });

    expect(models).toEqual([]);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("local llama.cpp discovery: malformed JSON response"),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("logs a warning when discovery JSON contains invalid UTF-8 bytes", async () => {
    const body = new Uint8Array([
      ...new TextEncoder().encode('{"data":[{"id":"qwen3-'),
      0xff,
      ...new TextEncoder().encode('"}]}'),
    ]);
    const release = queueResponse(
      new Response(body, { status: 200 }),
      "http://127.0.0.1:8080/v1/models",
    );
    const models = await discover({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "local llama.cpp",
    });

    expect(models).toEqual([]);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("local llama.cpp discovery: malformed JSON response"),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses guarded fetch pinned to the configured self-hosted provider", async () => {
    const propsResponse = cancelTrackedResponse({ status: 404 });
    const release = queueJson({ data: [{ id: "Qwen/Qwen3-32B" }] });
    const propsRelease = queueResponse(propsResponse.response, "http://127.0.0.1:8000/props");

    const models = await discover({
      baseUrl: "http://127.0.0.1:8000/v1/",
      apiKey: "self-hosted-test-key",
    });

    expect(models).toEqual([expectedModel("Qwen/Qwen3-32B")]);
    const headers = { Authorization: "Bearer self-hosted-test-key" };
    expectGuardedFetch(1, "http://127.0.0.1:8000/v1/models", 5000, headers);
    expectGuardedFetch(2, "http://127.0.0.1:8000/props", 2500, headers);
    expect(release).toHaveBeenCalledOnce();
    expect(propsRelease).toHaveBeenCalledOnce();
    expect(propsResponse.wasCanceled()).toBe(true);
  });

  it.each([
    ["context_length", 200_000],
    ["context_window", 400_000],
    ["context_size", 1_048_576],
  ] as const)("reads provider-advertised %s", async (field, contextWindow) => {
    const model = await discoverSingleCatalogModel({ id: "custom-model", [field]: contextWindow });

    expect(model).toMatchObject({ id: "custom-model", contextWindow });
  });

  it("keeps explicit and llama.cpp metadata ahead of top-level catalog fields", async () => {
    const row = {
      id: "custom-model",
      meta: { n_ctx_train: 262_144 },
      context_length: 200_000,
      context_window: 100_000,
      context_size: 50_000,
    };

    await expect(discoverSingleCatalogModel(row)).resolves.toMatchObject({
      contextWindow: 262_144,
    });

    await expect(
      discoverSingleCatalogModel(row, { contextWindow: 524_288 }),
    ).resolves.toMatchObject({ contextWindow: 524_288 });
  });

  it("uses a deterministic top-level field priority", async () => {
    const model = await discoverSingleCatalogModel({
      id: "custom-model",
      context_length: 300_000,
      context_window: 200_000,
      context_size: 100_000,
    });

    expect(model).toMatchObject({ contextWindow: 300_000 });
  });

  it.each([0, "1048576"])(
    "ignores malformed top-level context metadata: %j",
    async (contextSize) => {
      const model = await discoverSingleCatalogModel({
        id: "custom-model",
        context_size: contextSize,
      });

      expect(model).toMatchObject({ contextWindow: 128_000 });
    },
  );

  it("cancels model discovery error bodies before falling back", async () => {
    const release = vi.fn(async () => undefined);
    const response = cancelTrackedResponse({ status: 503, statusText: "Service Unavailable" });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: response.response,
      finalUrl: "http://127.0.0.1:8000/v1/models",
      release,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8000/v1/",
      apiKey: "self-hosted-test-key",
      label: "vLLM",
      env: {},
    });

    expect(models).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
    expect(response.wasCanceled()).toBe(true);
  });

  it("uses llama.cpp nested /props n_ctx as the runtime context cap", async () => {
    const modelsRelease = vi.fn(async () => undefined);
    const propsRelease = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen3.6-mxfp4-moe",
              meta: { n_ctx_train: 262_144 },
            },
          ],
        }),
        { status: 200 },
      ),
      finalUrl: "http://127.0.0.1:8080/v1/models",
      release: modelsRelease,
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ default_generation_settings: { n_ctx: 65_536 } }), {
        status: 200,
      }),
      finalUrl: "http://127.0.0.1:8080/props",
      release: propsRelease,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama.cpp",
      env: {},
    });

    expect(models).toEqual([
      expectedModel("qwen3.6-mxfp4-moe", { contextWindow: 262_144, contextTokens: 65_536 }),
    ]);
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "http://127.0.0.1:8080/props",
        init: { headers: undefined },
        policy: { allowedOrigins: ["http://127.0.0.1:8080"] },
        timeoutMs: 2500,
      }),
    );
    expect(modelsRelease).toHaveBeenCalledOnce();
    expect(propsRelease).toHaveBeenCalledOnce();
  });

  it("scopes llama.cpp /props runtime caps to each discovered model without autoloading", async () => {
    const modelsRelease = queueJson(
      {
        data: [
          { id: "qwen/router-a", meta: { n_ctx_train: 262_144 } },
          { id: "qwen/router-b", meta: { n_ctx_train: 131_072 } },
        ],
      },
      "http://127.0.0.1:8080/v1/models",
    );
    const firstPropsRelease = queueJson(
      { default_generation_settings: { n_ctx: 65_536 } },
      "http://127.0.0.1:8080/props?model=qwen%2Frouter-a&autoload=false",
    );
    const secondPropsRelease = queueJson(
      { default_generation_settings: { n_ctx: 32_768 } },
      "http://127.0.0.1:8080/props?model=qwen%2Frouter-b&autoload=false",
    );
    const models = await discover({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama.cpp",
    });

    expect(models).toEqual([
      expectedModel("qwen/router-a", { contextWindow: 262_144, contextTokens: 65_536 }),
      expectedModel("qwen/router-b", { contextWindow: 131_072, contextTokens: 32_768 }),
    ]);
    expectGuardedFetch(2, "http://127.0.0.1:8080/props?model=qwen%2Frouter-a&autoload=false", 2500);
    expectGuardedFetch(3, "http://127.0.0.1:8080/props?model=qwen%2Frouter-b&autoload=false", 2500);
    expect(modelsRelease).toHaveBeenCalledOnce();
    expect(firstPropsRelease).toHaveBeenCalledOnce();
    expect(secondPropsRelease).toHaveBeenCalledOnce();
  });

  it("keeps top-level llama.cpp /props n_ctx as a compatibility fallback", async () => {
    const modelsRelease = queueJson(
      { data: [{ id: "qwen3.6-mxfp4-moe", meta: { n_ctx_train: 262_144 } }] },
      "http://127.0.0.1:8080/v1/models",
    );
    const propsRelease = queueJson({ n_ctx: 65_536 }, "http://127.0.0.1:8080/props");
    const models = await discover({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama.cpp",
    });

    expect(models).toEqual([
      expectedModel("qwen3.6-mxfp4-moe", { contextWindow: 262_144, contextTokens: 65_536 }),
    ]);
    expect(modelsRelease).toHaveBeenCalledOnce();
    expect(propsRelease).toHaveBeenCalledOnce();
  });

  it("preserves explicit configured context windows ahead of llama.cpp /props", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          data: [{ id: "qwen3.6-mxfp4-moe", meta: { n_ctx_train: 262_144 } }],
        }),
        { status: 200 },
      ),
      finalUrl: "http://127.0.0.1:8080/v1/models",
      release,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama.cpp",
      contextWindow: 65_536,
      env: {},
    });

    expect(models).toEqual([expectedModel("qwen3.6-mxfp4-moe", { contextWindow: 65_536 })]);
    expect(models[0]).not.toHaveProperty("contextTokens");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds an unbounded /models discovery stream instead of buffering it", async () => {
    const oversized = createUnboundedJsonStream();
    const release = queueResponse(new Response(oversized.body, { status: 200 }));
    const models = await discover();

    // The reader cancels the body once the byte cap is exceeded; without the
    // cap the stream would never finish and the discovery would buffer it all.
    expect(models).toEqual([]);
    expect(oversized.cancelCount).toBe(1);
    expect(oversized.bytesPulled).toBeLessThanOrEqual(
      SELF_HOSTED_DISCOVERY_JSON_MAX_BYTES + 2 * CHUNK_BYTES,
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds an unbounded llama.cpp /props discovery stream instead of buffering it", async () => {
    const oversized = createUnboundedJsonStream();
    const modelsRelease = queueJson(
      { data: [{ id: "qwen3.6-mxfp4-moe" }] },
      "http://127.0.0.1:8080/v1/models",
    );
    const propsRelease = queueResponse(
      new Response(oversized.body, { status: 200 }),
      "http://127.0.0.1:8080/props",
    );
    const models = await discover({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama.cpp",
    });

    // /props overflow is swallowed so discovery still succeeds, but the body is
    // capped: the runtime context token probe is skipped, not OOM'd.
    expect(models).toEqual([expectedModel("qwen3.6-mxfp4-moe")]);
    expect(oversized.cancelCount).toBe(1);
    expect(oversized.bytesPulled).toBeLessThanOrEqual(
      SELF_HOSTED_DISCOVERY_JSON_MAX_BYTES + 2 * CHUNK_BYTES,
    );
    expect(modelsRelease).toHaveBeenCalledOnce();
    expect(propsRelease).toHaveBeenCalledOnce();
  });
});

describe("configureOpenAICompatibleSelfHostedProviderNonInteractive", () => {
  it("stops setup when the auth profile cannot be persisted", async () => {
    const ctx = createContext({ providerId: "vllm", modelId: "Qwen/Qwen3-32B" });
    const configBefore = structuredClone(ctx.config);
    const failure = new Error("Auth profile store is unavailable.");
    upsertAuthProfileWithLockOrThrow.mockRejectedValueOnce(failure);

    await expect(configureSelfHostedTestProvider({ ctx })).rejects.toBe(failure);
    expect(ctx.config).toEqual(configBefore);
    expect(ctx.runtime.log).not.toHaveBeenCalled();
  });

  it("configures provider config and auth profile", async () => {
    const params = {
      providerId: "vllm",
      providerLabel: "vLLM",
      envVar: "VLLM_API_KEY",
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
    expect(ctx.resolveApiKey).toHaveBeenCalledWith({
      provider: params.providerId,
      flagValue: params.apiKey,
      flagName: "--custom-api-key",
      envVar: params.envVar,
      envVarName: params.envVar,
    });
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
    const params = { providerId: "vllm", providerLabel: "vLLM", envVar: "VLLM_API_KEY" };
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
    rejectCredential(ctx, "Cannot encode an existing profile as a SecretRef.");

    const cfg = await configureSelfHostedTestProvider({ ctx, ...params });

    expect(cfg?.auth).toEqual(existingAuth);
    expect(cfg?.auth?.profiles?.[`${params.providerId}:default`]).toBeUndefined();
    expect(readPrimaryModel(cfg)).toBe(`${params.providerId}/${modelId}`);
    expect(JSON.stringify(cfg)).not.toContain(profileSecret);
    expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
    expect(upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
    expect(ctx.runtime.error).not.toHaveBeenCalled();
    expect(ctx.runtime.exit).not.toHaveBeenCalled();
  });

  it.each(["custom-local", "lmstudio-local"])(
    "keeps the LM Studio marker %s keyless in ref mode",
    async (marker) => {
      const params = providers.lmstudio;
      const modelId = "Qwen/Qwen3-32B";
      const ctx = createContext({ providerId: params.providerId, modelId });
      ctx.opts.secretInputMode = "ref";
      vi.mocked(ctx.resolveApiKey).mockResolvedValueOnce({ key: marker, source: "flag" });
      rejectCredential(ctx, "A synthetic non-secret marker must not become an auth credential.");

      const cfg = await configureSelfHostedTestProvider({ ctx, ...params });

      expect(readPrimaryModel(cfg)).toBe(`${params.providerId}/${modelId}`);
      expect(cfg?.auth?.profiles?.[`${params.providerId}:default`]).toBeUndefined();
      expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
      expect(upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
      expect(ctx.runtime.error).not.toHaveBeenCalled();
      expect(ctx.runtime.exit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["vllm", "custom-local"],
    ["vllm", "lmstudio-local"],
    ["lmstudio", "ollama-local"],
    ["lmstudio", "oauth:lmstudio"],
    ["lmstudio", "secretref-env:LM_API_TOKEN"],
    ["vllm", "fixture-genuine-self-hosted-secret"],
    ["vllm", "OPENAI_API_KEY"],
  ] as const)(
    "rejects %s unowned marker or genuine flag value %s in ref mode",
    async (provider, key) => {
      const params = providers[provider];
      const ctx = createContext({ providerId: params.providerId, modelId: "Qwen/Qwen3-32B" });
      ctx.opts.secretInputMode = "ref";
      vi.mocked(ctx.resolveApiKey).mockResolvedValueOnce({ key, source: "flag" });
      rejectCredential(ctx, "SecretRef mode requires an explicit environment variable.");

      const cfg = await configureSelfHostedTestProvider({ ctx, ...params });

      expect(cfg).toBeNull();
      expect(ctx.toApiKeyCredential).toHaveBeenCalledOnce();
      expect(upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
      expect(ctx.runtime.error).toHaveBeenCalledOnce();
      expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
    },
  );

  it("does not treat another provider's marker as keyless in plaintext mode", async () => {
    const ctx = createContext({ providerId: "vllm", modelId: "Qwen/Qwen3-32B" });
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
    const ctx = createContext({ providerId: "vllm", modelId: "Qwen/Qwen3-32B" });
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
    const ctx = createContext({ providerId: "vllm", modelId: "Qwen/Qwen3-32B" });
    vi.mocked(ctx.resolveApiKey).mockResolvedValueOnce(null);

    const cfg = await configureSelfHostedTestProvider({ ctx });

    expect(cfg).toBeNull();
    expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
    expect(upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
  });

  it("exits without touching auth when custom model id is missing", async () => {
    const ctx = createContext({
      providerId: "vllm",
      apiKey: "vllm-test-key",
    });

    const cfg = await configureSelfHostedTestProvider({ ctx });

    expect(cfg).toBeNull();
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      "Missing --custom-model-id for --auth-choice vllm.\nPass the vLLM model id to use, for example Qwen/Qwen3-32B.",
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
    expect(ctx.resolveApiKey).not.toHaveBeenCalled();
    expect(upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
  });
});
