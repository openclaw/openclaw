// Covers OpenAI-compatible embedding provider plugin behavior.
import "../test-utils/prepare-compiled-subprocesses.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, type Dispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemorySearchDeadlineControl,
  MEMORY_SEARCH_DEADLINE_CONTROL,
} from "../../packages/memory-host-sdk/src/host/search-deadline-control.js";
import { withTestTimeout } from "../../test/helpers/promise.js";
import type { ConfiguredProviderLocalServiceTarget } from "../agents/provider-local-service-target.js";
import type { EmbeddingProviderCreateOptions } from "./embedding-providers.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

async function createProvider(options: EmbeddingProviderCreateOptions) {
  const result = await openAICompatibleEmbeddingProviderAdapter.create(options);
  if (!result.provider) {
    throw new Error("expected OpenAI-compatible embedding provider");
  }
  const cacheKeyData = result.runtime?.cacheKeyData as
    | { baseUrl?: string; headers?: Record<string, string> }
    | undefined;
  return {
    provider: result.provider,
    client: {
      baseUrl: cacheKeyData?.baseUrl,
      headers: cacheKeyData?.headers ?? {},
    },
  };
}

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
};

type FixtureResponse = {
  object: "list";
  data: Array<{
    object?: "embedding";
    embedding: number[];
    index: number;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
};

type OversizedStreamServer = {
  baseUrl: string;
  closed: Promise<void>;
  getBodyBytesSent: () => number;
  getPlannedBodyBytes: () => number;
};

const servers: Array<{ close: () => Promise<void> }> = [];

function createOptions(
  overrides: Partial<EmbeddingProviderCreateOptions> = {},
): EmbeddingProviderCreateOptions {
  return {
    config: {} as EmbeddingProviderCreateOptions["config"],
    provider: "openai-compatible",
    model: "text-embedding-bge-m3",
    ...overrides,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

async function listen(server: Server, destroyConnections = false) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (destroyConnections) {
          server.closeAllConnections();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

function textEmbeddings({ body }: CapturedRequest, usage = false): FixtureResponse {
  const texts = Array.isArray(body.input) ? body.input : [body.input];
  return {
    object: "list",
    data: texts.map((text, index) => ({
      object: "embedding",
      embedding: [String(text).length, index + 0.25, 1],
      index,
    })),
    model: String(body.model),
    ...(usage ? { usage: { prompt_tokens: texts.length, total_tokens: texts.length } } : {}),
  };
}

function localProvider(baseUrl: string): EmbeddingProviderCreateOptions["config"] {
  return {
    models: {
      providers: {
        "gpu-spark": {
          api: "openai-completions",
          baseUrl,
          localService: { command: process.execPath },
          models: [],
        },
      },
    },
  };
}

async function providerAt(baseUrl: string) {
  return createProvider(createOptions({ remote: { baseUrl } }));
}

async function startEmbeddingServer(params?: {
  token?: string;
  respond?: (request: CapturedRequest) => FixtureResponse | Record<string, unknown> | null;
  status?: number;
  redirectUrl?: string;
}): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
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

        if (params?.token) {
          expect(req.headers.authorization).toBe(`Bearer ${params.token}`);
        } else {
          expect(req.headers.authorization).toBeUndefined();
        }

        res.writeHead(params?.status ?? 200, {
          "content-type": "application/json",
          ...(params?.redirectUrl ? { location: params.redirectUrl } : {}),
        });
        res.end(
          JSON.stringify(
            params?.respond
              ? params.respond(captured)
              : {
                  object: "list",
                  data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
                  model: body.model,
                },
          ),
        );
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    })();
  });

  return { baseUrl: await listen(server), requests };
}

const EMBEDDING_ERROR_BOUNDARY_PREFIX = "x".repeat(999);
const EMBEDDING_ERROR_BOUNDARY_BODY = `${EMBEDDING_ERROR_BOUNDARY_PREFIX}😀${"x".repeat(
  8 * 1024 - EMBEDDING_ERROR_BOUNDARY_PREFIX.length - 4,
)}`;

async function startHangingErrorEmbeddingServer(): Promise<{
  baseUrl: string;
  closed: Promise<void>;
}> {
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      await readJsonBody(req);
      res.on("close", resolveClosed);
      res.writeHead(502, { "content-type": "text/plain" });
      res.write(EMBEDDING_ERROR_BOUNDARY_BODY);
    })();
  });

  return {
    baseUrl: await listen(server, true),
    closed,
  };
}

async function startOversizedSuccessEmbeddingServer(): Promise<OversizedStreamServer> {
  const chunk = Buffer.alloc(64 * 1024, 0x20);
  const prefix = Buffer.from('{"data":[');
  const plannedBodyBytes = 64 * 1024 * 1024;
  let bodyBytesSent = 0;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      await readJsonBody(req);
      let closedAlready = false;
      res.on("close", () => {
        closedAlready = true;
        resolveClosed();
      });
      res.writeHead(200, { "content-type": "application/json" });
      const writeChunk = async (buffer: Buffer): Promise<boolean> => {
        if (closedAlready) {
          return false;
        }
        const accepted = res.write(buffer);
        bodyBytesSent += buffer.byteLength;
        if (accepted) {
          return true;
        }
        return await new Promise<boolean>((resolve) => {
          const cleanup = () => {
            res.off("drain", onDrain);
            res.off("close", onClose);
          };
          const onDrain = () => {
            cleanup();
            resolve(!closedAlready);
          };
          const onClose = () => {
            cleanup();
            resolve(false);
          };
          res.once("drain", onDrain);
          res.once("close", onClose);
        });
      };

      if (!(await writeChunk(prefix))) {
        return;
      }
      const chunksToSend = Math.ceil((plannedBodyBytes - bodyBytesSent) / chunk.byteLength);
      for (let i = 0; i < chunksToSend; i++) {
        if (!(await writeChunk(chunk))) {
          return;
        }
      }
      res.end("]}");
    })();
  });

  return {
    baseUrl: await listen(server, true),
    closed,
    getBodyBytesSent: () => bodyBytesSent,
    getPlannedBodyBytes: () => plannedBodyBytes,
  };
}

afterEach(async () => {
  const pending = servers.splice(0);
  await Promise.all(pending.map((server) => server.close()));
});

describe("openai-compatible generic embedding provider", () => {
  it("honors private-network denial for a configured provider and remote override", async () => {
    const server = await startEmbeddingServer();
    for (const remoteOverride of [false, true]) {
      const { provider } = await createProvider(
        createOptions({
          provider: "private-fixture",
          config: {
            models: {
              providers: {
                "private-fixture": {
                  api: "openai-completions",
                  baseUrl: remoteOverride ? "https://provider.example.test/v1" : server.baseUrl,
                  request: { allowPrivateNetwork: false },
                  models: [],
                },
              },
            },
          },
          ...(remoteOverride ? { remote: { baseUrl: server.baseUrl } } : {}),
        }),
      );
      await expect(provider.embed("private input")).rejects.toThrow(
        /private\/internal\/special-use/,
      );
    }
    expect(server.requests).toEqual([]);
  });

  it("does not extend configured private-network trust to another origin", async () => {
    const target = await startEmbeddingServer();
    const source = await startEmbeddingServer({
      status: 307,
      redirectUrl: `${target.baseUrl}/embeddings`,
    });
    const { provider } = await createProvider(
      createOptions({ remote: { baseUrl: source.baseUrl } }),
    );
    await expect(provider.embed("private input")).rejects.toThrow(/private\/internal\/special-use/);
    expect(source.requests).toHaveLength(1);
    expect(target.requests).toEqual([]);
  });

  it.each([true, false])("preserves caller-owned HTTP deadlines: signal=%s", async (withSignal) => {
    const server = await startEmbeddingServer();
    const { provider } = await createProvider(
      createOptions({ remote: { baseUrl: server.baseUrl } }),
    );
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
          ...(withSignal ? { signal: new AbortController().signal } : {}),
        }),
      ).resolves.toEqual([[0.1, 0.2, 0.3]]);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headersTimeout).toBe(withSignal ? 0 : undefined);
      expect(requests[0]?.bodyTimeout).toBe(withSignal ? 0 : undefined);
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
    const options = {
      ...createOptions({
        config: localProvider(server.baseUrl),
        provider: "gpu-spark",
        model: "gpu-spark/nomic-embed-text",
      }),
      acquireLocalService,
    };

    const { provider } = await createProvider(options);
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
    const options = createOptions({
      config: localProvider("http://spark.local:11434/v1"),
      provider: "gpu-spark",
      model: "gpu-spark/nomic-embed-text",
      remote: { baseUrl: server.baseUrl },
    }) as EmbeddingProviderCreateOptions & {
      acquireLocalService: typeof acquireLocalService;
    };
    options.acquireLocalService = acquireLocalService;

    const { provider } = await createProvider(options);
    await expect(provider.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(acquireLocalService).not.toHaveBeenCalled();
  });

  it("adds non-secret routing headers to runtime cache identity", async () => {
    const server = await startEmbeddingServer();
    const result = await openAICompatibleEmbeddingProviderAdapter.create(
      createOptions({
        model: "tenant-embedder",
        remote: {
          baseUrl: server.baseUrl,
          apiKey: "secret-api-key",
          headers: {
            "x-api-key": "also-secret",
            "x-deployment": "tenant-a",
          },
        },
      }),
    );

    expect(result.runtime?.cacheKeyData).toMatchObject({
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-deployment": "tenant-a",
      },
    });
    expect(result.runtime?.cacheKeyData).not.toHaveProperty("authorization");
    expect(
      (result.runtime!.cacheKeyData as { headers?: Record<string, string> }).headers,
    ).not.toHaveProperty("x-api-key");
  });

  it("aliases the exact prior custom-auth identity while keeping rotation stable", async () => {
    const canonical = {
      provider: "custom",
      baseUrl: "http://127.0.0.1:18001/v1",
      model: "fixture-embedding",
      dimensions: 3,
      inputType: "default",
      queryInputType: "query",
      documentInputType: "document",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-deployment": "tenant-a",
      },
    };
    for (const key of ["fixture-before", "fixture-after"]) {
      const result = await openAICompatibleEmbeddingProviderAdapter.create(
        createOptions({
          provider: "custom",
          model: "fixture-embedding",
          dimensions: 3,
          inputType: "default",
          queryInputType: "query",
          documentInputType: "document",
          config: {
            models: {
              providers: {
                custom: {
                  baseUrl: canonical.baseUrl,
                  headers: { "X-Access": key, "X-Deployment": "tenant-a" },
                  request: { auth: { mode: "header", headerName: " X-Access ", value: key } },
                  models: [],
                },
              },
            },
          },
        }),
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
      expect(result.runtime?.indexIdentityAliases).toEqual([
        {
          model: "fixture-embedding",
          cacheKeyData: priorIdentity,
        },
      ]);
      expect(JSON.stringify(result.runtime?.indexIdentityAliases?.[0]?.cacheKeyData)).toBe(
        JSON.stringify(priorIdentity),
      );
    }
  });

  it.each<{
    name: string;
    authHeaderName: string;
    headers: Record<string, string>;
    remote?: EmbeddingProviderCreateOptions["remote"];
  }>([
    { name: "standard auth", authHeaderName: "Authorization", headers: { Authorization: "key" } },
    { name: "sensitive custom auth", authHeaderName: "X-Api-Key", headers: { "X-Api-Key": "key" } },
    { name: "missing auth header", authHeaderName: "X-Access", headers: {} },
    {
      name: "another destination",
      authHeaderName: "X-Access",
      headers: { "X-Access": "key" },
      remote: { baseUrl: "http://127.0.0.1:18002/v1", headers: { "X-Access": "remote-route" } },
    },
  ])(
    "does not create an index identity alias for $name",
    async ({ authHeaderName, headers, remote }) => {
      const result = await openAICompatibleEmbeddingProviderAdapter.create(
        createOptions({
          provider: "custom",
          config: {
            models: {
              providers: {
                custom: {
                  baseUrl: "http://127.0.0.1:18001/v1",
                  headers,
                  request: { auth: { mode: "header", headerName: authHeaderName, value: "key" } },
                  models: [],
                },
              },
            },
          },
          remote,
        }),
      );
      expect(result.runtime?.indexIdentityAliases).toBeUndefined();
    },
  );

  it("posts OpenAI-compatible embedding requests without warming up during create", async () => {
    const token = "local-test-token";
    const server = await startEmbeddingServer({
      token,
      respond: (request) => textEmbeddings(request, true),
    });

    const { provider, client } = await createProvider(
      createOptions({
        model: "text-embedding-bge-m3",
        dimensions: 3,
        remote: {
          baseUrl: `  ${server.baseUrl}/  `,
          apiKey: `  ${token}  `,
          headers: {
            "x-local-runtime": "ollama",
          },
        },
      }),
    );

    expect(provider).toMatchObject({
      id: "openai-compatible",
      model: "text-embedding-bge-m3",
      dimensions: 3,
    });
    expect(client.baseUrl).toBe(server.baseUrl);
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

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/embeddings",
      body: {
        model: "text-embedding-bge-m3",
        input: ["hello"],
        dimensions: 3,
      },
    });
    expect(server.requests[0]?.body).not.toHaveProperty("encoding_format");
    expect(server.requests[0]?.body).not.toHaveProperty("input_type");
    expect(server.requests[0]?.headers).toMatchObject({
      "content-type": expect.stringContaining("application/json"),
      accept: "application/json",
      "x-local-runtime": "ollama",
    });
    expect(server.requests[1]?.body).toEqual({
      model: "text-embedding-bge-m3",
      input: ["a", "abcd"],
      dimensions: 3,
    });
  });

  it("returns endpoint vectors unchanged when dimensions are not configured", async () => {
    const server = await startEmbeddingServer({
      respond: () => ({
        object: "list",
        data: [
          { object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 },
          { object: "embedding", embedding: [0.4, 0.5], index: 1 },
        ],
      }),
    });
    const result = await openAICompatibleEmbeddingProviderAdapter.create(
      createOptions({ remote: { baseUrl: server.baseUrl } }),
    );

    expect(result.provider).not.toHaveProperty("dimensions");
    expect(result.runtime?.cacheKeyData).not.toHaveProperty("dimensions");
    await expect(result.provider?.embedBatch(["a", "b"])).resolves.toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5],
    ]);
    expect(server.requests[0]?.body).not.toHaveProperty("dimensions");
  });

  it("rejects vectors that do not match the requested dimensions", async () => {
    // Simulate a server that ignores `dimensions` and returns the model's native size.
    const native = await startEmbeddingServer({ respond: (request) => textEmbeddings(request) });
    const { provider } = await createProvider(
      createOptions({ dimensions: 2, remote: { baseUrl: native.baseUrl } }),
    );

    await expect(provider.embed("hello", { inputType: "query" })).rejects.toMatchObject({
      code: "INVALID_EMBEDDING_RESPONSE",
      expectedDimensions: 2,
      actualDimensions: 3,
      message:
        "openai-compatible embeddings failed (model: text-embedding-bge-m3, batch size: 1): expected 2 dimensions, got 3 at index 0; the endpoint did not honor the requested dimensions. Remove memory.search.outputDimensionality or request dimensions, or use a server that supports them.",
    });
    await expect(provider.embedBatch(["a", "b"], { inputType: "document" })).rejects.toMatchObject({
      code: "INVALID_EMBEDDING_RESPONSE",
      message:
        "openai-compatible embeddings failed (model: text-embedding-bge-m3, batch size: 2): expected 2 dimensions, got 3 at index 0; the endpoint did not honor the requested dimensions. Remove memory.search.outputDimensionality or request dimensions, or use a server that supports them.",
    });

    const { provider: wider } = await createProvider(
      createOptions({ dimensions: 4, remote: { baseUrl: native.baseUrl } }),
    );
    await expect(wider.embed("hello")).rejects.toThrow(
      "expected 4 dimensions, got 3 at index 0; the endpoint did not honor the requested dimensions. Remove memory.search.outputDimensionality or request dimensions, or use a server that supports them.",
    );
    expect(native.requests.map((request) => request.body.dimensions)).toEqual([2, 2, 4]);
  });

  it("keeps malformed response errors distinct from dimension mismatches", async () => {
    const server = await startEmbeddingServer({ respond: () => ({ data: [{}] }) });
    const { provider } = await createProvider(
      createOptions({ dimensions: 2, remote: { baseUrl: server.baseUrl } }),
    );
    const error = await provider.embed("query").catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "INVALID_EMBEDDING_RESPONSE",
      message: expect.stringContaining("missing embedding array at position 0"),
    });
    expect(error).not.toHaveProperty("expectedDimensions");
    expect(error).not.toHaveProperty("actualDimensions");
    expect(server.requests).toHaveLength(1);
  });

  it("rejects a batch when any vector differs from the requested dimensions", async () => {
    const server = await startEmbeddingServer({
      respond: () => ({
        object: "list",
        data: [
          { object: "embedding", embedding: [0, 0.6, 0.8], index: 2 },
          { object: "embedding", embedding: [0.6, 0.8], index: 1 },
          { object: "embedding", embedding: [1, 0], index: 0 },
        ],
      }),
    });
    const { provider } = await createProvider(
      createOptions({ dimensions: 2, remote: { baseUrl: server.baseUrl } }),
    );

    await expect(provider.embedBatch(["a", "b", "c"])).rejects.toMatchObject({
      code: "INVALID_EMBEDDING_RESPONSE",
      message:
        "openai-compatible embeddings failed (model: text-embedding-bge-m3, batch size: 3): expected 2 dimensions, got 3 at index 2; the endpoint did not honor the requested dimensions. Remove memory.search.outputDimensionality or request dimensions, or use a server that supports them.",
    });
  });

  it("bounds exact-limit embedding errors without splitting UTF-16 and cancels", async () => {
    const server = await startHangingErrorEmbeddingServer();
    const { provider } = await providerAt(server.baseUrl);

    const outcome = await withTestTimeout(
      provider.embed("hello").then(
        () => ({ type: "resolved" as const }),
        (error: unknown) => ({ type: "rejected" as const, error }),
      ),
      1_000,
      "timed out waiting for bounded embedding error",
    );

    if (outcome.type !== "rejected") {
      throw new Error(`expected embedding request to reject, got ${outcome.type}`);
    }
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toBe(
      `openai-compatible embeddings failed (model: text-embedding-bge-m3, batch size: 1): HTTP 502: ${EMBEDDING_ERROR_BOUNDARY_PREFIX}... [truncated]`,
    );
    await expect(
      withTestTimeout(
        server.closed.then(() => "closed" as const),
        1_000,
        "timed out waiting for embedding error server to close",
      ),
    ).resolves.toBe("closed");
  });

  it("bounds and cancels oversized successful embedding JSON bodies", async () => {
    const server = await startOversizedSuccessEmbeddingServer();
    const { provider } = await providerAt(server.baseUrl);

    await expect(provider.embed("hello")).rejects.toThrow(
      "openai-compatible embeddings failed (model: text-embedding-bge-m3, batch size: 1): JSON response exceeds 16777216 bytes",
    );
    await expect(
      withTestTimeout(
        server.closed.then(() => "closed" as const),
        1_000,
        "timed out waiting for oversized response server to close",
      ),
    ).resolves.toBe("closed");
    expect(server.getBodyBytesSent()).toBeLessThan(server.getPlannedBodyBytes() / 2);
  });

  it("maps configured memory input_type labels onto query and document requests", async () => {
    const server = await startEmbeddingServer({ respond: (request) => textEmbeddings(request) });

    const result = await openAICompatibleEmbeddingProviderAdapter.create(
      createOptions({
        model: "text-embedding-bge-m3",
        inputType: "  default  ",
        queryInputType: "  query  ",
        documentInputType: "  document  ",
        remote: { baseUrl: server.baseUrl },
      }),
    );
    const provider = result.provider;
    if (!provider) {
      throw new Error("expected openai-compatible provider");
    }

    expect(result.runtime?.cacheKeyData).toMatchObject({
      inputType: "default",
      queryInputType: "query",
      documentInputType: "document",
    });

    await expect(provider.embed("hello", { inputType: "query" })).resolves.toEqual([5, 0.25, 1]);
    await expect(provider.embedBatch(["doc"], { inputType: "document" })).resolves.toEqual([
      [3, 0.25, 1],
    ]);
    await expect(provider.embed("semantic", { inputType: "semantic" })).resolves.toEqual([
      8, 0.25, 1,
    ]);

    expect(server.requests.map((request) => request.body.input_type)).toEqual([
      "query",
      "document",
      "default",
    ]);
  });

  it("coerces structured text inputs and rejects inline data", async () => {
    const server = await startEmbeddingServer({
      respond: ({ body }) => {
        expect(body.input).toEqual(["ab"]);
        return {
          object: "list",
          data: [{ object: "embedding", embedding: [2, 1], index: 0 }],
        };
      },
    });
    const { provider } = await providerAt(server.baseUrl);

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
    await expect(
      createProvider(createOptions({ remote: { baseUrl: "   " }, model: "text-embedding-bge-m3" })),
    ).rejects.toThrow("remote.baseUrl");
    await expect(
      createProvider(
        createOptions({ remote: { baseUrl: "http://127.0.0.1:11434/v1" }, model: "   " }),
      ),
    ).rejects.toThrow("missing model");
  });
});
