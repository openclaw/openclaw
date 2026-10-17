import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { discoverOpenAICompatibleLocalModels } from "./provider-self-hosted-discovery.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/net/fetch-guard.js", () => ({ fetchWithSsrFGuard: fetchWithSsrFGuardMock }));

beforeEach(() => {
  vi.clearAllMocks();
});

function guarded(response: Response) {
  return {
    response,
    finalUrl: "http://127.0.0.1:8080",
    release: vi.fn(async () => undefined),
  };
}

type DiscoveryOptions = Partial<
  Omit<Parameters<typeof discoverOpenAICompatibleLocalModels>[0], "rawResult">
>;
const endpoint = { baseUrl: "http://127.0.0.1:8080/v1", label: "self-hosted" };

function discoverRaw(options: DiscoveryOptions = {}) {
  return discoverOpenAICompatibleLocalModels({
    ...endpoint,
    label: "llama-server",
    ...options,
    rawResult: true,
  });
}

function json(body: unknown) {
  return guarded(Response.json(body));
}

function loadedModels(length: number) {
  return Array.from({ length }, (_, index) => ({
    id: `model-${index}`,
    status: { value: "loaded" },
  }));
}

function mockRouter(
  models: Record<string, unknown>[],
  probe: (url: string) => Promise<ReturnType<typeof guarded>>,
) {
  fetchWithSsrFGuardMock.mockImplementation(async ({ url }: { url: string }) => {
    if (url.endsWith("/health")) {
      return guarded(new Response(null, { status: 200 }));
    }
    if (url.endsWith("/models")) {
      return json({ data: models });
    }
    return probe(url);
  });
}

const routerOptions = {
  healthPath: "/health",
  modelsPathOrder: "server-first",
  routerModelProps: true,
} as const;

async function exerciseClockStep(
  timeoutMs: number,
  expectedProbes: number,
  advance: () => void,
  restore: () => void,
) {
  const started = createDeferred();
  const release = createDeferred();
  let active = 0;
  mockRouter(loadedModels(17), async () => {
    if (++active === 8) {
      started.resolve();
    }
    await release.promise;
    return json({ n_ctx: 8192 });
  });
  const pending = discoverRaw({ ...routerOptions, timeoutMs });
  try {
    await withTestTimeout(started.promise, 1_000, "initial eight property probes did not start");
    // Move the clock only once the first wave is blocked, independent of runner load.
    advance();
    release.resolve();
    const result = await withTestTimeout(pending, 1_000, "discovery did not finish");
    expect(result.kind === "success" ? result.rows : []).toHaveLength(17);
    expect(propertyProbeCount()).toBe(expectedProbes);
  } finally {
    release.resolve();
    restore();
    await withTestTimeout(pending, 1_000, "property probes did not settle during cleanup");
  }
}

function propertyProbeCount() {
  return fetchWithSsrFGuardMock.mock.calls.filter(([call]) => call.url.includes("/props?")).length;
}

async function discoverModels(data: Record<string, unknown>[], label = "self-hosted") {
  fetchWithSsrFGuardMock.mockResolvedValueOnce(json({ data }));
  return discoverOpenAICompatibleLocalModels({
    ...endpoint,
    label,
    discoverRuntimeContext: false,
    env: {},
  });
}

async function discoverModelContexts(
  data: Record<string, unknown>[],
  contextWindow?: number,
): Promise<Record<string, number | undefined>> {
  fetchWithSsrFGuardMock.mockResolvedValueOnce(json({ data }));
  const models = await discoverOpenAICompatibleLocalModels({
    ...endpoint,
    contextWindow,
    discoverRuntimeContext: false,
    env: {},
  });
  return Object.fromEntries(models.map((model) => [model.id, model.contextWindow]));
}

describe("discoverOpenAICompatibleLocalModels raw discovery", () => {
  it("resolves only the configured provider's request secrets and preserves its transport policy", async () => {
    const config = {
      models: {
        providers: {
          litellm: {
            baseUrl: "https://192.168.1.2/v1",
            headers: {
              "X-Tenant": { source: "env", provider: "default", id: "PROXY_TENANT" },
            },
            request: {
              allowPrivateNetwork: false,
              headers: { "X-Request": "discovery" },
              proxy: {
                mode: "explicit-proxy",
                url: "https://proxy.example:8443",
                tls: { ca: { source: "env", provider: "default", id: "PROXY_CA" } },
              },
            },
            models: [],
          },
          unrelated: {
            baseUrl: "https://other.example/v1",
            headers: {
              "X-Unavailable": { source: "env", provider: "default", id: "MISSING_OTHER_KEY" },
            },
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const source = structuredClone(config);
    fetchWithSsrFGuardMock.mockResolvedValueOnce(
      guarded(Response.json({ data: [{ id: "local-qwen" }] })),
    );

    const result = await discoverRaw({
      baseUrl: "https://192.168.1.2/v1",
      apiKey: "fixture-key",
      configuredProvider: { config, id: "litellm" },
      env: { PROXY_TENANT: "fixture-tenant", PROXY_CA: "fixture-proxy-ca" },
      label: "LiteLLM",
      discoverRuntimeContext: false,
    });

    expect(result).toMatchObject({ kind: "success", rows: [{ model: { id: "local-qwen" } }] });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: "https://192.168.1.2/v1/models",
        init: {
          headers: {
            Authorization: "Bearer fixture-key",
            "X-Tenant": "fixture-tenant",
            "X-Request": "discovery",
          },
        },
        policy: undefined,
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "https://proxy.example:8443",
          proxyTls: { ca: "fixture-proxy-ca" },
        },
      }),
    );
    expect(config).toEqual(source);
  });

  it("retains discovered total parameter counts and display names", async () => {
    const models = await discoverModels([
      { id: "compact-chat", name: "Compact Chat", parameterCount: 4_000_000_000 },
      { id: "alias", name: "Qwen3 4B" },
      { id: "invalid", parameterCount: 0 },
    ]);
    expect(models.map(({ id, name, parameterCount }) => ({ id, name, parameterCount }))).toEqual([
      { id: "compact-chat", name: "Compact Chat", parameterCount: 4_000_000_000 },
      { id: "alias", name: "Qwen3 4B", parameterCount: undefined },
      { id: "invalid", name: "invalid", parameterCount: undefined },
    ]);
  });

  it("recognizes reasoning aliases without enabling legacy chat models", async () => {
    const expected = [
      { id: "yk_nemotron-3-super", reasoning: true },
      { id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16", reasoning: true },
      { id: "nvidia/nemotron-3-8b-chat-4k-sft", reasoning: false },
      { id: "yk_deepseek_v4", reasoning: true },
      { id: "DeepSeek-V4-Flash", reasoning: true },
      { id: "deepseek-chat", reasoning: false },
      { id: "plain-chat", reasoning: false },
    ];
    const models = await discoverModels(
      expected.map(({ id }) => ({ id })),
      "vLLM",
    );
    expect(models.map(({ id, reasoning }) => ({ id, reasoning }))).toEqual(expected);
  });

  it("preserves health and falls back from root /models to /v1/models", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(guarded(new Response(null, { status: 503 })))
      .mockResolvedValueOnce(guarded(new Response(null, { status: 404 })))
      .mockResolvedValueOnce(json({ data: [{ id: "model", object: "model" }] }))
      .mockResolvedValueOnce(json({ n_ctx: 8192 }));

    await expect(
      discoverRaw({
        serverBaseUrl: "http://127.0.0.1:8080",
        ...routerOptions,
      }),
    ).resolves.toMatchObject({
      kind: "success",
      health: "loading",
      rows: [{ model: { id: "model" }, props: { n_ctx: 8192 } }],
    });
    expect(fetchWithSsrFGuardMock.mock.calls.map(([call]) => call.url)).toEqual([
      "http://127.0.0.1:8080/health",
      "http://127.0.0.1:8080/models",
      "http://127.0.0.1:8080/v1/models",
      "http://127.0.0.1:8080/props",
    ]);
  });

  it("separates transport, HTTP, and invalid model-list responses", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("connection refused"));
    await expect(discoverRaw({ healthPath: "/health" })).resolves.toMatchObject({
      kind: "unreachable",
    });

    fetchWithSsrFGuardMock.mockResolvedValueOnce(guarded(new Response(null, { status: 401 })));
    await expect(discoverRaw({ healthPath: "/health" })).resolves.toEqual({
      kind: "http-error",
      path: "/health",
      status: 401,
    });

    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(guarded(new Response(null, { status: 200 })))
      .mockResolvedValueOnce(guarded(new Response("<html></html>", { status: 200 })))
      .mockResolvedValueOnce(guarded(new Response("{", { status: 200 })));
    await expect(
      discoverRaw({ healthPath: "/health", modelsPathOrder: "server-first" }),
    ).resolves.toMatchObject({ kind: "invalid-response", path: "/v1/models" });
  });

  it.each([401, 503])("keeps root model-list HTTP %s failures terminal", async (status) => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce(guarded(new Response(null, { status })));

    await expect(discoverRaw({ modelsPathOrder: "server-first" })).resolves.toEqual({
      kind: "http-error",
      path: "/models",
      status,
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });

  it("probes only available router models without autoloading", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(guarded(new Response(null, { status: 200 })))
      .mockResolvedValueOnce(
        json({
          data: [
            { id: "loaded/model", status: { value: "loaded" } },
            { id: "unloaded/model", status: { value: "unloaded" } },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ n_ctx: 16_384 }));

    const result = await discoverRaw(routerOptions);

    expect(result).toMatchObject({
      kind: "success",
      rows: [
        { model: { id: "loaded/model" }, props: { n_ctx: 16_384 } },
        { model: { id: "unloaded/model" } },
      ],
    });
    expect(fetchWithSsrFGuardMock.mock.calls.map(([call]) => call.url)).toEqual([
      "http://127.0.0.1:8080/health",
      "http://127.0.0.1:8080/models",
      "http://127.0.0.1:8080/props?model=loaded%2Fmodel&autoload=false",
    ]);
  });

  it("stops scheduling router property probes after the shared deadline", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    await exerciseClockStep(
      10,
      8,
      () => now.mockReturnValue(20),
      () => now.mockRestore(),
    );
  });

  it("keeps scheduling router property probes through a forward wall-clock step", async () => {
    const now = Date.now;
    let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + offset);
    await exerciseClockStep(
      1_000,
      17,
      () => {
        offset = 60_000;
      },
      () => clock.mockRestore(),
    );
  });

  it("bounds concurrent property probes and keeps results associated by model", async () => {
    const models = loadedModels(10);
    const started = models.map(() => createDeferred());
    const releases = models.map(() => createDeferred());
    let active = 0;
    let maxActive = 0;
    mockRouter(models, async (url) => {
      const modelId = new URL(url).searchParams.get("model");
      const index = Number(modelId?.replace("model-", ""));
      active += 1;
      maxActive = Math.max(maxActive, active);
      started[index]!.resolve();
      await releases[index]!.promise;
      active -= 1;
      return json({ n_ctx: 8_000 + index });
    });

    const resultPromise = discoverRaw(routerOptions);

    try {
      await withTestTimeout(
        started[7]!.promise,
        1_000,
        "initial eight property probes did not start",
      );
      // Finish later models first so completion order cannot stand in for model identity.
      releases[7]!.resolve();
      await withTestTimeout(
        started[8]!.promise,
        1_000,
        "model-8 probe did not start after model-7",
      );
      releases[6]!.resolve();
      await withTestTimeout(
        started[9]!.promise,
        1_000,
        "model-9 probe did not start after model-6",
      );
      for (const release of releases.toReversed()) {
        release.resolve();
      }
      const result = await withTestTimeout(resultPromise, 1_000, "discovery did not finish");

      expect(maxActive).toBe(8);
      expect(result.kind === "success" ? result.rows.map((row) => row.props?.n_ctx) : []).toEqual(
        models.map((_, index) => 8_000 + index),
      );
    } finally {
      for (const release of releases) {
        release.resolve();
      }
      await withTestTimeout(resultPromise, 1_000, "property probes did not settle during cleanup");
    }
  });

  it("caps property probes at 200 models", async () => {
    const models = loadedModels(201);
    mockRouter(models, async () => json({ n_ctx: 8192 }));

    const result = await discoverRaw(routerOptions);

    expect(result.kind === "success" ? result.rows : []).toHaveLength(201);
    expect(propertyProbeCount()).toBe(200);
  });

  it("keeps explicit Authorization ahead of ambient API-key discovery", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(guarded(new Response(null, { status: 200 })))
      .mockResolvedValueOnce(json({ data: [] }));

    await discoverRaw({
      apiKey: "ambient-key",
      headers: { Authorization: "Bearer explicit-key" },
      healthPath: "/health",
      modelsPathOrder: "server-first",
    });

    for (const [call] of fetchWithSsrFGuardMock.mock.calls) {
      expect(call.init.headers).toMatchObject({
        Accept: "application/json",
        Authorization: "Bearer explicit-key",
      });
    }
  });
});

describe("discoverOpenAICompatibleLocalModels context metadata", () => {
  it("uses explicit, metadata, own, parent, then default context precedence", async () => {
    await expect(
      discoverModelContexts([
        { id: "context-length", context_length: 4_096 },
        { id: "context-window", context_window: 8_192 },
        { id: "context-size", context_size: 12_288 },
        { id: " Base/Model ", max_model_len: 32_768 },
        {
          id: "metadata",
          meta: { n_ctx_train: 24_576 },
          max_model_len: 16_384,
          parent: "Base/Model",
        },
        { id: "own", max_model_len: 16_384, parent: "Base/Model" },
        { id: "child", parent: " Base/Model " },
        { id: "default" },
      ]),
    ).resolves.toEqual({
      "context-length": 4_096,
      "context-window": 8_192,
      "context-size": 12_288,
      "Base/Model": 32_768,
      metadata: 24_576,
      own: 16_384,
      child: 32_768,
      default: 128_000,
    });

    await expect(
      discoverModelContexts(
        [
          { id: "base", max_model_len: 32_768 },
          {
            id: "configured",
            meta: { n_ctx_train: 24_576 },
            max_model_len: 16_384,
            parent: "base",
          },
        ],
        2_048,
      ),
    ).resolves.toEqual({ base: 2_048, configured: 2_048 });
  });

  it("inherits only one exact direct parent top-level context", async () => {
    await expect(
      discoverModelContexts([
        { id: "Parent", max_model_len: 8_192 },
        { id: "case-mismatch", parent: "parent" },
        { id: "self", parent: "self" },
        { id: "cycle-a", parent: "cycle-b" },
        { id: "cycle-b", parent: "cycle-a" },
        { id: "grandparent", max_model_len: 4_096 },
        { id: "middle", parent: "grandparent" },
        { id: "child", parent: "middle" },
        { id: "root-only", root: "Parent" },
        { id: "metadata-parent", meta: { n_ctx_train: 6_144 } },
        { id: "metadata-child", parent: "metadata-parent" },
        { id: "invalid-parent", max_model_len: 0 },
        { id: "invalid-child", parent: "invalid-parent" },
      ]),
    ).resolves.toEqual({
      Parent: 8_192,
      "case-mismatch": 128_000,
      self: 128_000,
      "cycle-a": 128_000,
      "cycle-b": 128_000,
      grandparent: 4_096,
      middle: 4_096,
      child: 128_000,
      "root-only": 128_000,
      "metadata-parent": 6_144,
      "metadata-child": 128_000,
      "invalid-parent": 128_000,
      "invalid-child": 128_000,
    });
  });
});
