// Covers OpenAI-compatible embedding provider plugin behavior.
import "../test-utils/prepare-compiled-subprocesses.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemorySearchDeadlineControl,
  MEMORY_SEARCH_DEADLINE_CONTROL,
} from "../../packages/memory-host-sdk/src/host/search-deadline-control.js";
import { withTestTimeout } from "../../test/helpers/promise.js";
import type { ConfiguredProviderLocalServiceTarget } from "../agents/provider-local-service-target.js";
import type { EmbeddingProviderCreateOptions } from "./embedding-providers.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

async function createOpenAICompatibleEmbeddingProvider(options: EmbeddingProviderCreateOptions) {
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

async function startEmbeddingServer(params?: {
  token?: string;
  respond?: (request: CapturedRequest) => FixtureResponse | Record<string, unknown> | null;
  status?: number;
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

        res.writeHead(params?.status ?? 200, { "content-type": "application/json" });
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
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
  };
}

const EMBEDDING_ERROR_BOUNDARY_PREFIX = "x".repeat(999);
const EMBEDDING_ERROR_BOUNDARY_BODY = `${EMBEDDING_ERROR_BOUNDARY_PREFIX}😀${"x".repeat(
  8 * 1024 - EMBEDDING_ERROR_BOUNDARY_PREFIX.length - 4,
)}`;

async function startHangingErrorEmbeddingServer(): Promise<{
  baseUrl: string;
  closed: Promise<void>;
}> {
  const sockets = new Set<Socket>();
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
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

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
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    closed,
  };
}

async function startOversizedSuccessEmbeddingServer(): Promise<OversizedStreamServer> {
  const chunk = Buffer.alloc(64 * 1024, 0x20);
  const prefix = Buffer.from('{"data":[');
  const plannedBodyBytes = 64 * 1024 * 1024;
  const sockets = new Set<Socket>();
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
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

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
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
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
        config: {
          models: {
            providers: {
              "gpu-spark": {
                api: "openai-completions",
                baseUrl: server.baseUrl,
                localService: { command: process.execPath },
                models: [],
              },
            },
          },
        },
        provider: "gpu-spark",
        model: "gpu-spark/nomic-embed-text",
      }),
      acquireLocalService,
    };

    const { provider } = await createOpenAICompatibleEmbeddingProvider(options);
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
      config: {
        models: {
          providers: {
            "gpu-spark": {
              api: "openai-completions",
              baseUrl: "http://spark.local:11434/v1",
              localService: { command: process.execPath },
              models: [],
            },
          },
        },
      } as EmbeddingProviderCreateOptions["config"],
      provider: "gpu-spark",
      model: "gpu-spark/nomic-embed-text",
      remote: { baseUrl: server.baseUrl },
    }) as EmbeddingProviderCreateOptions & {
      acquireLocalService: typeof acquireLocalService;
    };
    options.acquireLocalService = acquireLocalService;

    const { provider } = await createOpenAICompatibleEmbeddingProvider(options);
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

  it("posts OpenAI-compatible embedding requests without warming up during create", async () => {
    const token = "local-test-token";
    const server = await startEmbeddingServer({
      token,
      respond: ({ body }) => {
        const input = body.input;
        const texts = Array.isArray(input) ? input : [input];
        return {
          object: "list",
          data: texts.map((text, index) => ({
            object: "embedding",
            embedding: [String(text).length, index + 0.25, 1],
            index,
          })),
          model: String(body.model),
          usage: { prompt_tokens: texts.length, total_tokens: texts.length },
        };
      },
    });

    const { provider, client } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({
        model: "text-embedding-bge-m3",
        dimensions: 1024,
        remote: {
          baseUrl: `  ${server.baseUrl}/  `,
          apiKey: `  ${token}  `,
          headers: {
            "x-local-runtime": "ollama",
          },
        },
      }),
    );

    expect(provider.id).toBe("openai-compatible");
    expect(provider.model).toBe("text-embedding-bge-m3");
    expect(provider.dimensions).toBe(1024);
    expect(client.baseUrl).toBe(server.baseUrl);
    expect(server.requests).toHaveLength(0);

    await expect(provider.embed("hello")).resolves.toEqual([5, 0.25, 1]);
    await expect(provider.embedBatch(["a", "abcd"])).resolves.toEqual([
      [1, 0.25, 1],
      [4, 1.25, 1],
    ]);

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/embeddings",
      body: {
        model: "text-embedding-bge-m3",
        input: ["hello"],
        dimensions: 1024,
      },
    });
    expect(server.requests[0]?.body).not.toHaveProperty("encoding_format");
    expect(server.requests[0]?.body).not.toHaveProperty("input_type");
    expect(server.requests[0]?.headers["content-type"]).toContain("application/json");
    expect(server.requests[0]?.headers.accept).toBe("application/json");
    expect(server.requests[0]?.headers["x-local-runtime"]).toBe("ollama");
    expect(server.requests[1]?.body).toEqual({
      model: "text-embedding-bge-m3",
      input: ["a", "abcd"],
      dimensions: 1024,
    });
  });

  it("bounds exact-limit embedding errors without splitting UTF-16 and cancels", async () => {
    const server = await startHangingErrorEmbeddingServer();
    const { provider } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({
        model: "text-embedding-bge-m3",
        remote: { baseUrl: server.baseUrl },
      }),
    );

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
      `openai-compatible embeddings failed: HTTP 502: ${EMBEDDING_ERROR_BOUNDARY_PREFIX}... [truncated]`,
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
    const { provider } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({
        model: "text-embedding-bge-m3",
        remote: { baseUrl: server.baseUrl },
      }),
    );

    await expect(provider.embed("hello")).rejects.toThrow(
      "openai-compatible embeddings failed: JSON response exceeds 16777216 bytes",
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
    const server = await startEmbeddingServer({
      respond: ({ body }) => {
        const input = body.input;
        const texts = Array.isArray(input) ? input : [input];
        return {
          object: "list",
          data: texts.map((text, index) => ({
            object: "embedding",
            embedding: [String(text).length, index + 0.25, 1],
            index,
          })),
          model: String(body.model),
        };
      },
    });

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
    const { provider } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({ remote: { baseUrl: server.baseUrl } }),
    );

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
      createOpenAICompatibleEmbeddingProvider(
        createOptions({ remote: { baseUrl: "   " }, model: "text-embedding-bge-m3" }),
      ),
    ).rejects.toThrow("remote.baseUrl");
    await expect(
      createOpenAICompatibleEmbeddingProvider(
        createOptions({ remote: { baseUrl: "http://127.0.0.1:11434/v1" }, model: "   " }),
      ),
    ).rejects.toThrow("missing model");
  });
});
