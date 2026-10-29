import "../test-utils/prepare-compiled-subprocesses.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Agent, type Dispatcher } from "undici";
import { afterEach, expect, it, vi } from "vitest";
import {
  createMemorySearchDeadlineControl,
  MEMORY_SEARCH_DEADLINE_CONTROL,
} from "../../packages/memory-host-sdk/src/host/search-deadline-control.js";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
  respondJson,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import type {
  AcquireConfiguredProviderLocalService,
  ConfiguredProviderLocalServiceTarget,
} from "../agents/provider-local-service-target.js";
import type { EmbeddingProviderCreateOptions } from "./embedding-providers.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

type CreateOptions = EmbeddingProviderCreateOptions & {
  acquireLocalService?: AcquireConfiguredProviderLocalService;
};
async function createProvider(options: Partial<CreateOptions> = {}) {
  const result = await openAICompatibleEmbeddingProviderAdapter.create({
    config: {},
    provider: "openai-compatible",
    model: "text-embedding-bge-m3",
    ...options,
  });
  if (!result.provider) {
    throw new Error("expected OpenAI-compatible embedding provider");
  }
  return { ...result, provider: result.provider };
}

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
};

const servers: Server[] = [];

function configuredOptions(
  provider: string,
  config: NonNullable<
    NonNullable<EmbeddingProviderCreateOptions["config"]["models"]>["providers"]
  >[string],
  overrides: Partial<EmbeddingProviderCreateOptions> = {},
) {
  return {
    provider,
    config: { models: { providers: { [provider]: config } } },
    ...overrides,
  };
}

function vectors(...embeddings: number[][]) {
  return { data: embeddings.map((embedding, index) => ({ embedding, index })) };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return JSON.parse(await readRequestText(req)) as Record<string, unknown>;
}

async function listen(server: Server) {
  const baseUrl = await listenLoopback(server);
  servers.push(server);
  return `${baseUrl}/v1`;
}

function textEmbeddings({ body }: CapturedRequest, usage = false) {
  const texts = Array.isArray(body.input) ? body.input : [body.input];
  return {
    data: texts.map((text, index) => ({
      embedding: [String(text).length, index + 0.25, 1],
      index,
    })),
    ...(usage ? { usage: { prompt_tokens: texts.length, total_tokens: texts.length } } : {}),
  };
}

function localProvider(baseUrl: string, options: Partial<CreateOptions> = {}) {
  return createProvider({
    ...configuredOptions("gpu-spark", {
      api: "openai-completions",
      baseUrl,
      localService: { command: process.execPath },
      models: [],
    }),
    model: "gpu-spark/nomic-embed-text",
    ...options,
  });
}

async function providerAt(
  baseUrl: string,
  overrides: Partial<EmbeddingProviderCreateOptions> = {},
) {
  return createProvider({ remote: { baseUrl }, ...overrides });
}

async function startEmbeddingServer(params?: {
  token?: string;
  respond?: (request: CapturedRequest) => Record<string, unknown> | null;
  status?: number;
  redirectUrl?: string;
  hang?: string;
}) {
  const requests: CapturedRequest[] = [];
  const { promise: closed, resolve: resolveClosed } = createDeferred();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readJsonBody(req);
        const captured: CapturedRequest = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        };
        requests.push(captured);
        res.on("close", resolveClosed);

        if (params?.token) {
          expect(req.headers.authorization).toBe(`Bearer ${params.token}`);
        } else {
          expect(req.headers.authorization).toBeUndefined();
        }

        if (params?.hang) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.write(params.hang);
          return;
        }
        res.writeHead(params?.status ?? 200, {
          "content-type": "application/json",
          ...(params?.redirectUrl ? { location: params.redirectUrl } : {}),
        });
        res.end(
          JSON.stringify(params?.respond ? params.respond(captured) : vectors([0.1, 0.2, 0.3])),
        );
      } catch (error) {
        respondJson(res, { error: error instanceof Error ? error.message : String(error) }, 500);
      }
    })();
  });

  return { baseUrl: await listen(server), requests, closed };
}

const EMBEDDING_ERROR_BOUNDARY_PREFIX = "x".repeat(999);
const EMBEDDING_ERROR_BOUNDARY_BODY = `${EMBEDDING_ERROR_BOUNDARY_PREFIX}😀${"x".repeat(
  8 * 1024 - EMBEDDING_ERROR_BOUNDARY_PREFIX.length - 4,
)}`;

async function embeddingFixture(
  serverOptions?: Parameters<typeof startEmbeddingServer>[0],
  options: Partial<EmbeddingProviderCreateOptions> = {},
) {
  const server = await startEmbeddingServer(serverOptions);
  return {
    ...server,
    ...(await providerAt(server.baseUrl, {
      ...options,
      remote: { baseUrl: server.baseUrl, ...options.remote },
    })),
  };
}

function customAuth(
  headerName: string,
  headers: Record<string, string>,
  options: Partial<EmbeddingProviderCreateOptions> = {},
  value = "key",
) {
  return createProvider(
    configuredOptions(
      "custom",
      {
        baseUrl: "http://127.0.0.1:18001/v1",
        headers,
        request: { auth: { mode: "header", headerName, value } },
        models: [],
      },
      options,
    ),
  );
}

afterEach(async () => {
  const pending = servers.splice(0);
  await Promise.all(pending.map(closeHttpServer));
});

it("honors private-network denial for a configured provider and remote override", async () => {
  const server = await startEmbeddingServer();
  for (const remoteOverride of [false, true]) {
    const { provider } = await createProvider(
      configuredOptions(
        "private-fixture",
        {
          api: "openai-completions",
          baseUrl: remoteOverride ? "https://provider.example.test/v1" : server.baseUrl,
          request: { allowPrivateNetwork: false },
          models: [],
        },
        remoteOverride ? { remote: { baseUrl: server.baseUrl } } : {},
      ),
    );
    await expect(provider.embed("private input")).rejects.toThrow(/private\/internal\/special-use/);
  }
  expect(server.requests).toEqual([]);
});

it("does not extend configured private-network trust to another origin", async () => {
  const target = await startEmbeddingServer();
  const source = await startEmbeddingServer({
    status: 307,
    redirectUrl: `${target.baseUrl}/embeddings`,
  });
  const { provider } = await providerAt(source.baseUrl);
  await expect(provider.embed("private input")).rejects.toThrow(/private\/internal\/special-use/);
  expect(source.requests).toHaveLength(1);
  expect(target.requests).toEqual([]);
});

it("preserves caller-owned HTTP deadlines", async () => {
  const { provider } = await embeddingFixture();
  const requests: Dispatcher.DispatchOptions[] = [];
  // oxlint-disable-next-line typescript/unbound-method -- The observer calls the original with the same Agent receiver.
  const dispatch = Agent.prototype.dispatch;
  const spy = vi.spyOn(Agent.prototype, "dispatch").mockImplementation(function (
    this: Agent,
    options,
    handler,
  ) {
    requests.push(options);
    return dispatch.call(this, options, handler);
  });
  try {
    await expect(
      provider.embedBatch(["document"], {
        inputType: "document",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([[0.1, 0.2, 0.3]]);
    expect(requests).toHaveLength(1);
    expect([requests[0]?.headersTimeout, requests[0]?.bodyTimeout]).toEqual([0, 0]);
  } finally {
    spy.mockRestore();
  }
});

it("forwards readiness phases without pausing reconciliation", async () => {
  const server = await startEmbeddingServer();
  const release = vi.fn();
  const events: string[] = [];
  const acquireLocalService = vi.fn(async (target: ConfiguredProviderLocalServiceTarget) => {
    events.push("acquire");
    target.onReadinessWait?.(true);
    target.onReadinessWait?.(false);
    events.push("reconcile");
    return { release };
  });
  const { provider } = await localProvider(server.baseUrl, { acquireLocalService });
  const control = createMemorySearchDeadlineControl();
  control.subscribe((action) => events.push(action));
  const caller = new AbortController();
  await expect(
    provider.embed("hello", {
      signal: caller.signal,
      [MEMORY_SEARCH_DEADLINE_CONTROL]: control,
    }),
  ).resolves.toEqual([0.1, 0.2, 0.3]);

  expect(events).toEqual(["acquire", "pause", "resume", "reconcile"]);
  expect(acquireLocalService).toHaveBeenCalledWith(expect.anything(), caller.signal);
  expect(release).toHaveBeenCalledOnce();
});

it("does not lease a configured local service for a remote endpoint override", async () => {
  const server = await startEmbeddingServer();
  const acquireLocalService = vi.fn(async () => ({ release: vi.fn() }));
  const { provider } = await localProvider("http://spark.local:11434/v1", {
    remote: { baseUrl: server.baseUrl },
    acquireLocalService,
  });
  await expect(provider.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
  expect(acquireLocalService).not.toHaveBeenCalled();
});

it("adds non-secret routing headers to runtime cache identity", async () => {
  const result = await embeddingFixture(undefined, {
    model: "tenant-embedder",
    remote: {
      apiKey: "secret-api-key",
      headers: {
        "x-api-key": "also-secret",
        "x-deployment": "tenant-a",
      },
    },
  });

  expect(result.runtime?.cacheKeyData).toMatchObject({ headers: { "x-deployment": "tenant-a" } });
  expect(
    (result.runtime!.cacheKeyData as { headers?: Record<string, string> }).headers,
  ).not.toHaveProperty("x-api-key");
});

it("aliases the exact prior custom-auth identity while keeping rotation stable", async () => {
  const canonical = {
    provider: "custom",
    baseUrl: "http://127.0.0.1:18001/v1",
    model: "fixture-embedding",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-deployment": "tenant-a",
    },
  };
  for (const key of ["fixture-before", "fixture-after"]) {
    const result = await customAuth(
      " X-Access ",
      { "X-Access": key, "X-Deployment": "tenant-a" },
      { model: "fixture-embedding" },
      key,
    );
    const priorIdentity = {
      ...canonical,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-access": key,
        "x-deployment": "tenant-a",
      },
    };
    expect(result.runtime?.cacheKeyData).toEqual(canonical);
    expect(result.runtime?.indexIdentityAliases).toHaveLength(1);
    expect(result.runtime?.indexIdentityAliases?.[0]?.model).toBe("fixture-embedding");
    expect(JSON.stringify(result.runtime?.indexIdentityAliases?.[0]?.cacheKeyData)).toBe(
      JSON.stringify(priorIdentity),
    );
  }
});

it.each<[string, Record<string, string>, EmbeddingProviderCreateOptions["remote"]?]>([
  ["Authorization", { Authorization: "key" }],
  ["X-Api-Key", { "X-Api-Key": "key" }],
  ["X-Access", {}],
  [
    "X-Access",
    { "X-Access": "key" },
    {
      baseUrl: "http://127.0.0.1:18002/v1",
      headers: { "X-Access": "remote-route" },
    },
  ],
])(
  "does not create an index identity alias for %s with %j and remote %j",
  async (authHeaderName, headers, remote) => {
    const result = await customAuth(authHeaderName, headers, { remote });
    expect(result.runtime?.indexIdentityAliases).toBeUndefined();
  },
);

it("posts OpenAI-compatible embedding requests without warming up during create", async () => {
  const token = "local-test-token";
  const server = await startEmbeddingServer({
    token,
    respond: (request) => textEmbeddings(request, true),
  });

  const { provider, runtime } = await createProvider({
    dimensions: 3,
    remote: {
      baseUrl: `  ${server.baseUrl}/  `,
      apiKey: `  ${token}  `,
      headers: {
        "x-local-runtime": "ollama",
      },
    },
  });

  expect(runtime?.cacheKeyData).toMatchObject({ baseUrl: server.baseUrl });
  expect(server.requests).toHaveLength(0);

  const onUsage = vi.fn();
  await expect(provider.embed("hello", { onUsage })).resolves.toEqual([5, 0.25, 1]);
  await expect(provider.embedBatch(["a", "abcd"], { onUsage })).resolves.toEqual([
    [1, 0.25, 1],
    [4, 1.25, 1],
  ]);
  expect(onUsage.mock.calls).toEqual([
    [{ promptTokens: 1, totalTokens: 1 }],
    [{ promptTokens: 2, totalTokens: 2 }],
  ]);

  expect(server.requests[0]).toMatchObject({
    method: "POST",
    url: "/v1/embeddings",
    headers: {
      "content-type": expect.stringContaining("application/json"),
      accept: "application/json",
      "x-local-runtime": "ollama",
    },
  });
  expect(server.requests.map(({ body }) => body)).toEqual([
    { model: "text-embedding-bge-m3", input: ["hello"], dimensions: 3 },
    { model: "text-embedding-bge-m3", input: ["a", "abcd"], dimensions: 3 },
  ]);
});

it("returns endpoint vectors unchanged when dimensions are not configured", async () => {
  const result = await embeddingFixture({
    respond: () => vectors([0.1, 0.2, 0.3], [0.4, 0.5]),
  });

  expect(result.provider).not.toHaveProperty("dimensions");
  expect(result.runtime?.cacheKeyData).not.toHaveProperty("dimensions");
  await expect(result.provider?.embedBatch(["a", "b"])).resolves.toEqual([
    [0.1, 0.2, 0.3],
    [0.4, 0.5],
  ]);
  expect(result.requests[0]?.body).not.toHaveProperty("dimensions");
});

it("rejects mismatched dimensions after ordering every vector in the batch", async () => {
  const { provider, requests } = await embeddingFixture(
    {
      respond: () => ({
        data: [
          { embedding: [0, 0.6, 0.8], index: 2 },
          { embedding: [0.6, 0.8], index: 1 },
          { embedding: [1, 0], index: 0 },
        ],
      }),
    },
    { dimensions: 2 },
  );
  await expect(provider.embedBatch(["a", "b", "c"])).rejects.toMatchObject({
    code: "INVALID_EMBEDDING_RESPONSE",
    expectedDimensions: 2,
    actualDimensions: 3,
    message:
      "openai-compatible embeddings failed (model: text-embedding-bge-m3, batch size: 3): expected 2 dimensions, got 3 at index 2; the endpoint did not honor the requested dimensions. Remove memory.search.outputDimensionality or request dimensions, or use a server that supports them.",
  });
  expect(requests[0]?.body.dimensions).toBe(2);
});

it("keeps malformed response errors distinct from dimension mismatches", async () => {
  const { provider } = await embeddingFixture(
    { respond: () => ({ data: [{}] }) },
    { dimensions: 2 },
  );
  const error = await provider.embed("query").catch((cause: unknown) => cause);
  expect(error).toMatchObject({
    code: "INVALID_EMBEDDING_RESPONSE",
    message: expect.stringContaining("missing embedding array at position 0"),
  });
  expect(error).not.toHaveProperty("expectedDimensions");
  expect(error).not.toHaveProperty("actualDimensions");
});

it("bounds exact-limit embedding errors without splitting UTF-16 and cancels", async () => {
  const server = await startEmbeddingServer({ hang: EMBEDDING_ERROR_BOUNDARY_BODY });
  const { provider } = await providerAt(server.baseUrl);

  const request = withTestTimeout(
    provider.embed("hello"),
    1_000,
    "timed out waiting for bounded embedding error",
  );
  await expect(request).rejects.toBeInstanceOf(Error);
  await expect(request).rejects.toMatchObject({
    message: `openai-compatible embeddings failed (model: text-embedding-bge-m3, batch size: 1): HTTP 502: ${EMBEDDING_ERROR_BOUNDARY_PREFIX}... [truncated]`,
  });
  await expect(
    withTestTimeout(server.closed, 1_000, "timed out waiting for embedding error server to close"),
  ).resolves.toBeUndefined();
});

it("maps configured memory input_type labels onto query and document requests", async () => {
  const { provider, runtime, requests } = await embeddingFixture(
    { respond: textEmbeddings },
    { inputType: "  default  ", queryInputType: "  query  ", documentInputType: "  document  " },
  );

  expect(runtime?.cacheKeyData).toMatchObject({
    inputType: "default",
    queryInputType: "query",
    documentInputType: "document",
  });

  await provider.embed("hello", { inputType: "query" });
  await provider.embedBatch(["doc"], { inputType: "document" });
  await provider.embed("semantic", { inputType: "semantic" });

  expect(requests.map((request) => request.body.input_type)).toEqual([
    "query",
    "document",
    "default",
  ]);
});

it("coerces structured text inputs and rejects inline data", async () => {
  const { provider } = await embeddingFixture({
    respond: ({ body }) => {
      expect(body.input).toEqual(["ab"]);
      return vectors([2, 1]);
    },
  });

  await expect(
    provider.embed({
      text: "ignored",
      parts: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    }),
  ).resolves.toEqual([2, 1]);
  await expect(
    provider.embed({
      text: "image",
      parts: [{ type: "inline-data", mimeType: "image/png", data: "AA==" }],
    }),
  ).rejects.toThrow("only support text embedding inputs");
});

it("reports missing required config with actionable keys", async () => {
  await expect(providerAt("   ")).rejects.toThrow("remote.baseUrl");
  await expect(providerAt("http://127.0.0.1:11434/v1", { model: "   " })).rejects.toThrow(
    "missing model",
  );
});
