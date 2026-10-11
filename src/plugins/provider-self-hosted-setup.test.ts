/** Tests self-hosted provider setup helpers and auth/config defaults. */
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

// Mirrors SELF_HOSTED_DISCOVERY_JSON_MAX_BYTES in the source under test. Kept in
// sync deliberately so the regression asserts the body is capped, not drained.
const SELF_HOSTED_DISCOVERY_JSON_MAX_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

/**
 * Builds a Response body that would never terminate on its own: each pull emits
 * a 1 MiB chunk forever. A bounded reader must cancel it after the byte cap.
 */
function createUnboundedJsonStream(): {
  body: ReadableStream<Uint8Array>;
  cancelCount: number;
  bytesPulled: number;
} {
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
  return {
    body,
    get cancelCount() {
      return state.cancelCount;
    },
    get bytesPulled() {
      return state.bytesPulled;
    },
  };
}

function createRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

function createContext(params: {
  providerId: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
}): ProviderAuthMethodNonInteractiveContext {
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
    runtime: createRuntime() as never,
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
  providerId: string;
  providerLabel: string;
  envVar: string;
}) {
  return await configureOpenAICompatibleSelfHostedProviderNonInteractive({
    ctx: params.ctx,
    providerId: params.providerId,
    providerLabel: params.providerLabel,
    defaultBaseUrl: "http://127.0.0.1:8000/v1",
    defaultApiKeyEnvVar: params.envVar,
    modelPlaceholder: "Qwen/Qwen3-32B",
  });
}

function cancelTrackedResponse(init?: ResponseInit): {
  response: Response;
  wasCanceled: () => boolean;
} {
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

describe("discoverOpenAICompatibleLocalModels", () => {
  it("retains valid models when a provider catalog contains malformed entries", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          data: [
            { id: "valid-a", meta: { n_ctx_train: 32_768 } },
            null,
            7,
            "invalid",
            [],
            { id: "valid-b", meta: { n_ctx_train: 65_536 } },
          ],
        }),
        { status: 200 },
      ),
      finalUrl: "http://127.0.0.1:8000/v1/models",
      release,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8000/v1",
      label: "vLLM",
      discoverRuntimeContext: false,
      env: {},
    });

    expect(models).toMatchObject([
      { id: "valid-a", contextWindow: 32_768 },
      { id: "valid-b", contextWindow: 65_536 },
    ]);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects a non-array model catalog", async () => {
    const data = {};
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ data }), { status: 200 }),
      finalUrl: "http://127.0.0.1:8000/v1/models",
      release,
    });

    await expect(
      discoverOpenAICompatibleLocalModels({
        baseUrl: "http://127.0.0.1:8000/v1",
        label: "vLLM",
        discoverRuntimeContext: false,
        env: {},
      }),
    ).resolves.toEqual([]);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("vLLM discovery: malformed JSON response"),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("logs a warning when discovery JSON contains invalid UTF-8 bytes", async () => {
    const release = vi.fn(async () => undefined);
    const body = new Uint8Array([
      ...new TextEncoder().encode('{"data":[{"id":"qwen3-'),
      0xff,
      ...new TextEncoder().encode('"}]}'),
    ]);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(body, { status: 200 }),
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

  it("uses guarded fetch pinned to the configured self-hosted provider", async () => {
    const release = vi.fn(async () => undefined);
    const propsRelease = vi.fn(async () => undefined);
    const propsResponse = cancelTrackedResponse({ status: 404 });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ data: [{ id: "Qwen/Qwen3-32B" }] }), {
        status: 200,
      }),
      finalUrl: "http://127.0.0.1:8000/v1/models",
      release,
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: propsResponse.response,
      finalUrl: "http://127.0.0.1:8000/props",
      release: propsRelease,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8000/v1/",
      apiKey: "self-hosted-test-key",
      label: "vLLM",
      env: {},
    });

    expect(models).toEqual([expectedModel("Qwen/Qwen3-32B")]);
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "http://127.0.0.1:8000/v1/models",
        init: { headers: { Authorization: "Bearer self-hosted-test-key" } },
        policy: { allowedOrigins: ["http://127.0.0.1:8000"] },
        timeoutMs: 5000,
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "http://127.0.0.1:8000/props",
        init: { headers: { Authorization: "Bearer self-hosted-test-key" } },
        policy: { allowedOrigins: ["http://127.0.0.1:8000"] },
        timeoutMs: 2500,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
    expect(propsRelease).toHaveBeenCalledOnce();
    expect(propsResponse.wasCanceled()).toBe(true);
  });

  it("scopes llama.cpp /props runtime caps to each discovered model without autoloading", async () => {
    const modelsRelease = vi.fn(async () => undefined);
    const firstPropsRelease = vi.fn(async () => undefined);
    const secondPropsRelease = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen/router-a",
              meta: { n_ctx_train: 262_144 },
            },
            {
              id: "qwen/router-b",
              meta: { n_ctx_train: 131_072 },
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
      finalUrl: "http://127.0.0.1:8080/props?model=qwen%2Frouter-a&autoload=false",
      release: firstPropsRelease,
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ default_generation_settings: { n_ctx: 32_768 } }), {
        status: 200,
      }),
      finalUrl: "http://127.0.0.1:8080/props?model=qwen%2Frouter-b&autoload=false",
      release: secondPropsRelease,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama.cpp",
      env: {},
    });

    expect(models).toEqual([
      expectedModel("qwen/router-a", { contextWindow: 262_144, contextTokens: 65_536 }),
      expectedModel("qwen/router-b", { contextWindow: 131_072, contextTokens: 32_768 }),
    ]);
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "http://127.0.0.1:8080/props?model=qwen%2Frouter-a&autoload=false",
        init: { headers: undefined },
        policy: { allowedOrigins: ["http://127.0.0.1:8080"] },
        timeoutMs: 2500,
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: "http://127.0.0.1:8080/props?model=qwen%2Frouter-b&autoload=false",
        init: { headers: undefined },
        policy: { allowedOrigins: ["http://127.0.0.1:8080"] },
        timeoutMs: 2500,
      }),
    );
    expect(modelsRelease).toHaveBeenCalledOnce();
    expect(firstPropsRelease).toHaveBeenCalledOnce();
    expect(secondPropsRelease).toHaveBeenCalledOnce();
  });

  it("keeps top-level llama.cpp /props n_ctx as a compatibility fallback", async () => {
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
      response: new Response(JSON.stringify({ n_ctx: 65_536 }), { status: 200 }),
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
    expect(modelsRelease).toHaveBeenCalledOnce();
    expect(propsRelease).toHaveBeenCalledOnce();
  });

  it("bounds an unbounded /models discovery stream instead of buffering it", async () => {
    const release = vi.fn(async () => undefined);
    const oversized = createUnboundedJsonStream();
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(oversized.body, { status: 200 }),
      finalUrl: "http://127.0.0.1:8000/v1/models",
      release,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8000/v1",
      label: "vLLM",
      env: {},
    });

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
    const modelsRelease = vi.fn(async () => undefined);
    const propsRelease = vi.fn(async () => undefined);
    const oversized = createUnboundedJsonStream();
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ data: [{ id: "qwen3.6-mxfp4-moe" }] }), {
        status: 200,
      }),
      finalUrl: "http://127.0.0.1:8080/v1/models",
      release: modelsRelease,
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(oversized.body, { status: 200 }),
      finalUrl: "http://127.0.0.1:8080/props",
      release: propsRelease,
    });

    const models = await discoverOpenAICompatibleLocalModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      label: "llama.cpp",
      env: {},
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

    await expect(
      configureSelfHostedTestProvider({
        ctx,
        providerId: "vllm",
        providerLabel: "vLLM",
        envVar: "VLLM_API_KEY",
      }),
    ).rejects.toBe(failure);
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

    const cfg = await configureSelfHostedTestProvider({
      ctx,
      providerId: params.providerId,
      providerLabel: params.providerLabel,
      envVar: params.envVar,
    });

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
    vi.mocked(ctx.toApiKeyCredential).mockImplementationOnce(() => {
      ctx.runtime.error("Cannot encode an existing profile as a SecretRef.");
      ctx.runtime.exit(1);
      return null;
    });

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

  it.each([
    {
      providerId: "lmstudio",
      providerLabel: "LM Studio",
      envVar: "LM_API_TOKEN",
      marker: "custom-local",
    },
    {
      providerId: "lmstudio",
      providerLabel: "LM Studio",
      envVar: "LM_API_TOKEN",
      marker: "lmstudio-local",
    },
  ])("keeps the $providerLabel non-secret marker keyless in ref mode", async (params) => {
    const modelId = "Qwen/Qwen3-32B";
    const ctx = createContext({ providerId: params.providerId, modelId });
    ctx.opts.secretInputMode = "ref";
    vi.mocked(ctx.resolveApiKey).mockResolvedValueOnce({ key: params.marker, source: "flag" });
    vi.mocked(ctx.toApiKeyCredential).mockImplementationOnce(() => {
      ctx.runtime.error("A synthetic non-secret marker must not become an auth credential.");
      ctx.runtime.exit(1);
      return null;
    });

    const cfg = await configureSelfHostedTestProvider({ ctx, ...params });

    expect(readPrimaryModel(cfg)).toBe(`${params.providerId}/${modelId}`);
    expect(cfg?.auth?.profiles?.[`${params.providerId}:default`]).toBeUndefined();
    expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
    expect(upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
    expect(ctx.runtime.error).not.toHaveBeenCalled();
    expect(ctx.runtime.exit).not.toHaveBeenCalled();
  });

  it.each([
    { providerId: "vllm", providerLabel: "vLLM", envVar: "VLLM_API_KEY", key: "custom-local" },
    { providerId: "vllm", providerLabel: "vLLM", envVar: "VLLM_API_KEY", key: "lmstudio-local" },
    {
      providerId: "lmstudio",
      providerLabel: "LM Studio",
      envVar: "LM_API_TOKEN",
      key: "ollama-local",
    },
    {
      providerId: "lmstudio",
      providerLabel: "LM Studio",
      envVar: "LM_API_TOKEN",
      key: "oauth:lmstudio",
    },
    {
      providerId: "lmstudio",
      providerLabel: "LM Studio",
      envVar: "LM_API_TOKEN",
      key: "secretref-env:LM_API_TOKEN",
    },
    {
      providerId: "vllm",
      providerLabel: "vLLM",
      envVar: "VLLM_API_KEY",
      key: "fixture-genuine-self-hosted-secret",
    },
    { providerId: "vllm", providerLabel: "vLLM", envVar: "VLLM_API_KEY", key: "OPENAI_API_KEY" },
  ])(
    "rejects unowned marker or genuine flag value $key for $providerLabel in ref mode",
    async ({ key, ...params }) => {
      const ctx = createContext({ providerId: params.providerId, modelId: "Qwen/Qwen3-32B" });
      ctx.opts.secretInputMode = "ref";
      vi.mocked(ctx.resolveApiKey).mockResolvedValueOnce({ key, source: "flag" });
      vi.mocked(ctx.toApiKeyCredential).mockImplementationOnce(() => {
        ctx.runtime.error("SecretRef mode requires an explicit environment variable.");
        ctx.runtime.exit(1);
        return null;
      });

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

    const cfg = await configureSelfHostedTestProvider({
      ctx,
      providerId: "vllm",
      providerLabel: "vLLM",
      envVar: "VLLM_API_KEY",
    });

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

    const cfg = await configureSelfHostedTestProvider({
      ctx,
      providerId: "vllm",
      providerLabel: "vLLM",
      envVar: "VLLM_API_KEY",
    });

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

    const cfg = await configureSelfHostedTestProvider({
      ctx,
      providerId: "vllm",
      providerLabel: "vLLM",
      envVar: "VLLM_API_KEY",
    });

    expect(cfg).toBeNull();
    expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
    expect(upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
  });

  it("exits without touching auth when custom model id is missing", async () => {
    const ctx = createContext({
      providerId: "vllm",
      apiKey: "vllm-test-key",
    });

    const cfg = await configureSelfHostedTestProvider({
      ctx,
      providerId: "vllm",
      providerLabel: "vLLM",
      envVar: "VLLM_API_KEY",
    });

    expect(cfg).toBeNull();
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      [
        "Missing --custom-model-id for --auth-choice vllm.",
        "Pass the vLLM model id to use, for example Qwen/Qwen3-32B.",
      ].join("\n"),
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
    expect(ctx.resolveApiKey).not.toHaveBeenCalled();
    expect(upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
  });
});
