import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { discoverOpenAICompatibleLocalModels } from "./provider-self-hosted-discovery.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/net/fetch-guard.js", () => ({ fetchWithSsrFGuard: fetchWithSsrFGuardMock }));

beforeEach(() => {
  vi.clearAllMocks();
});

function waitForProbe<T>(promise: Promise<T>, message: string) {
  return withTestTimeout(promise, 1_000, message);
}

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
const rawEndpoint = { ...endpoint, label: "llama-server", rawResult: true } as const;

function discoverRaw(options: DiscoveryOptions = {}) {
  return discoverOpenAICompatibleLocalModels({ ...rawEndpoint, ...options });
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
    await waitForProbe(started.promise, "initial eight property probes did not start");
    // Move the clock only once the first wave is blocked, independent of runner load.
    advance();
    release.resolve();
    const result = await waitForProbe(pending, "discovery did not finish");
    expect(result.kind === "success" ? result.rows : []).toHaveLength(17);
    expect(propertyProbeCount()).toBe(expectedProbes);
  } finally {
    release.resolve();
    restore();
    await waitForProbe(pending, "property probes did not settle during cleanup");
  }
}

function propertyProbeCount() {
  return fetchWithSsrFGuardMock.mock.calls.filter(([call]) => call.url.includes("/props?")).length;
}

async function discoverModels(data: Record<string, unknown>[], contextWindow?: number) {
  fetchWithSsrFGuardMock.mockResolvedValueOnce(json({ data }));
  return discoverOpenAICompatibleLocalModels({
    ...endpoint,
    contextWindow,
    discoverRuntimeContext: false,
    env: {},
  });
}

async function expectModelContexts(
  cases: Record<string, [Record<string, unknown>, number]>,
  contextWindow?: number,
) {
  const models = await discoverModels(
    Object.entries(cases).map(([id, [fields]]) => Object.assign({ id }, fields)),
    contextWindow,
  );
  expect(Object.fromEntries(models.map((model) => [model.id, model.contextWindow]))).toEqual(
    Object.fromEntries(Object.entries(cases).map(([id, [, context]]) => [id, context])),
  );
}

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
  const models = await discoverModels(expected.map(({ id }) => ({ id })));
  expect(models.map(({ id, reasoning }) => ({ id, reasoning }))).toEqual(expected);
});

it("preserves health and falls back from root /models to /v1/models", async () => {
  fetchWithSsrFGuardMock
    .mockResolvedValueOnce(guarded(new Response(null, { status: 503 })))
    .mockResolvedValueOnce(guarded(new Response(null, { status: 404 })))
    .mockResolvedValueOnce(json({ data: [{ id: "model", object: "model" }] }))
    .mockResolvedValueOnce(json({ n_ctx: 8192 }));

  await expect(
    discoverRaw({ serverBaseUrl: "http://127.0.0.1:8080", ...routerOptions }),
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
    await waitForProbe(started[7]!.promise, "initial eight property probes did not start");
    // Finish later models first so completion order cannot stand in for model identity.
    releases[7]!.resolve();
    await waitForProbe(started[8]!.promise, "model-8 probe did not start after model-7");
    releases[6]!.resolve();
    await waitForProbe(started[9]!.promise, "model-9 probe did not start after model-6");
    for (const release of releases.toReversed()) {
      release.resolve();
    }
    const result = await waitForProbe(resultPromise, "discovery did not finish");

    expect(maxActive).toBe(8);
    expect(result.kind === "success" ? result.rows.map((row) => row.props?.n_ctx) : []).toEqual(
      models.map((_, index) => 8_000 + index),
    );
  } finally {
    for (const release of releases) {
      release.resolve();
    }
    await waitForProbe(resultPromise, "property probes did not settle during cleanup");
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

it("uses explicit, metadata, own, parent, then default context precedence", async () => {
  const metadata = { meta: { n_ctx_train: 24_576 }, max_model_len: 16_384 };
  await expectModelContexts({
    "context-length": [{ context_length: 4_096 }, 4_096],
    "context-window": [{ context_window: 8_192 }, 8_192],
    "context-size": [{ context_size: 12_288 }, 12_288],
    "Base/Model": [{ id: " Base/Model ", max_model_len: 32_768 }, 32_768],
    metadata: [{ ...metadata, parent: "Base/Model" }, 24_576],
    own: [{ max_model_len: 16_384, parent: "Base/Model" }, 16_384],
    child: [{ parent: " Base/Model " }, 32_768],
    default: [{}, 128_000],
  });
  await expectModelContexts(
    {
      base: [{ max_model_len: 32_768 }, 2_048],
      configured: [{ ...metadata, parent: "base" }, 2_048],
    },
    2_048,
  );
});

it("inherits only one exact direct parent top-level context", async () => {
  await expectModelContexts({
    Parent: [{ max_model_len: 8_192 }, 8_192],
    "case-mismatch": [{ parent: "parent" }, 128_000],
    self: [{ parent: "self" }, 128_000],
    "cycle-a": [{ parent: "cycle-b" }, 128_000],
    "cycle-b": [{ parent: "cycle-a" }, 128_000],
    grandparent: [{ max_model_len: 4_096 }, 4_096],
    middle: [{ parent: "grandparent" }, 4_096],
    child: [{ parent: "middle" }, 128_000],
    "root-only": [{ root: "Parent" }, 128_000],
    "metadata-parent": [{ meta: { n_ctx_train: 6_144 } }, 6_144],
    "metadata-child": [{ parent: "metadata-parent" }, 128_000],
    "invalid-parent": [{ max_model_len: 0 }, 128_000],
    "invalid-child": [{ parent: "invalid-parent" }, 128_000],
  });
});
