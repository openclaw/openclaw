// Covers the OpenAI-compatible embedding provider's per-call stall deadlines.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EMBEDDING_STALL_TIMEOUT_ERROR_NAME } from "../../packages/memory-host-sdk/src/host/embedding-stall-timeout.js";
import { withTestTimeout } from "../../test/helpers/promise.js";
import type { EmbeddingProviderCreateOptions } from "./embedding-providers.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

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
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startNeverRespondingEmbeddingServer(): Promise<{ baseUrl: string }> {
  const sockets = new Set<Socket>();
  const server = createServer((req: IncomingMessage, _res: ServerResponse) => {
    void readJsonBody(req).then(() => {
      // Never respond: the request hangs until the client gives up.
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
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
  return { baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function startDelayedEmbeddingServer(delayMs: number): Promise<{ baseUrl: string }> {
  const sockets = new Set<Socket>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void readJsonBody(req).then(() => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
      }, delayMs);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
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
  return { baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

afterEach(async () => {
  const pending = servers.splice(0);
  await Promise.all(pending.map((server) => server.close()));
});

async function createProvider(options: EmbeddingProviderCreateOptions) {
  const result = await openAICompatibleEmbeddingProviderAdapter.create(options);
  if (!result.provider) {
    throw new Error("expected openai-compatible embedding provider");
  }
  return result.provider;
}

describe("openai-compatible embedding stall deadlines", () => {
  it("times out stalled query embedding calls with the built-in query deadline", async () => {
    const server = await startNeverRespondingEmbeddingServer();
    const provider = await createProvider(createOptions({ remote: { baseUrl: server.baseUrl } }));
    // Memory Core's recall lane aborts at 15s; the built-in 10s query deadline
    // must win so default-config users see the precise embedding timeout.
    const controller = new AbortController();
    const callerAbort = setTimeout(() => controller.abort(), 15_000);
    const startedAt = Date.now();

    try {
      const outcome = await withTestTimeout(
        provider.embed("hello", { inputType: "query", signal: controller.signal }).then(
          () => ({ type: "resolved" as const }),
          (error: unknown) => ({ type: "rejected" as const, error }),
        ),
        14_000,
        "timed out waiting for the built-in query deadline",
      );
      if (outcome.type !== "rejected") {
        throw new Error(`expected embedding request to reject, got ${outcome.type}`);
      }
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      expect((outcome.error as Error).message).toBe(
        "openai-compatible embeddings request timed out after 10s",
      );
      expect((outcome.error as Error).name).toBe(EMBEDDING_STALL_TIMEOUT_ERROR_NAME);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      clearTimeout(callerAbort);
    }
  }, 20_000);

  it("keeps labeled document batches outside the provider stall deadline even with timeoutSeconds", async () => {
    const server = await startDelayedEmbeddingServer(1_500);
    const provider = await createProvider(
      createOptions({
        config: {
          models: {
            providers: {
              "tenant-embeddings": {
                baseUrl: server.baseUrl,
                timeoutSeconds: 1,
                models: [],
              },
            },
          },
        } as EmbeddingProviderCreateOptions["config"],
        provider: "tenant-embeddings",
        model: "text-embedding-bge-m3",
      }),
    );

    // timeoutSeconds feeds Memory Core's embedding budgets; it must not
    // resurrect a provider-side document-lane deadline.
    await expect(
      withTestTimeout(
        provider.embedBatch(["doc"], { inputType: "document" }),
        5_000,
        "timed out waiting for the delayed document batch",
      ),
    ).resolves.toEqual([[0.1, 0.2]]);
  });

  it("keeps the caller signal ahead of the client stall deadline", async () => {
    const server = await startNeverRespondingEmbeddingServer();
    const provider = await createProvider(
      createOptions({
        config: {
          models: {
            providers: {
              "tenant-embeddings": {
                baseUrl: server.baseUrl,
                timeoutSeconds: 30,
                models: [],
              },
            },
          },
        } as EmbeddingProviderCreateOptions["config"],
        provider: "tenant-embeddings",
        model: "text-embedding-bge-m3",
      }),
    );
    const controller = new AbortController();
    const callerAbort = setTimeout(() => controller.abort(), 150);

    try {
      const outcome = await withTestTimeout(
        provider.embed("hello", { inputType: "query", signal: controller.signal }).then(
          () => ({ type: "resolved" as const }),
          (error: unknown) => ({ type: "rejected" as const, error }),
        ),
        5_000,
        "timed out waiting for the caller abort",
      );
      if (outcome.type !== "rejected") {
        throw new Error(`expected embedding request to reject, got ${outcome.type}`);
      }
      expect((outcome.error as Error).message).not.toContain("request timed out after");
    } finally {
      clearTimeout(callerAbort);
    }
  });

  it("starts the stall deadline only after local service readiness (#136405)", async () => {
    const server = await startDelayedEmbeddingServer(50);
    const acquireLocalService = (target: unknown, signal?: AbortSignal) =>
      new Promise<{ release: () => void }>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ release: () => {} }), 1_500);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("lease aborted"));
          },
          { once: true },
        );
      });
    const options = createOptions({
      config: {
        models: {
          providers: {
            "gpu-spark": {
              baseUrl: server.baseUrl,
              stallTimeoutSeconds: 1,
              localService: { command: process.execPath },
              models: [],
            },
          },
        },
      } as EmbeddingProviderCreateOptions["config"],
      provider: "gpu-spark",
      model: "gpu-spark/text-embedding-bge-m3",
    }) as EmbeddingProviderCreateOptions & {
      acquireLocalService: typeof acquireLocalService;
    };
    options.acquireLocalService = acquireLocalService;
    const provider = await createProvider(options);

    // A healthy 1.5s cold start outlasts the effective 1s query stall
    // deadline: readiness must not consume it, and the deadline starts only
    // for the HTTP call.
    const startedAt = Date.now();
    await withTestTimeout(
      provider.embed("hello", { inputType: "query" }),
      5_000,
      "timed out waiting for the post-readiness embedding call",
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
  });

  it("aborts hanging local service acquisition on the caller signal only", async () => {
    const server = await startNeverRespondingEmbeddingServer();
    const acquireLocalService = (target: unknown, signal?: AbortSignal) =>
      new Promise<{ release: () => void }>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("lease aborted")), {
          once: true,
        });
      });
    const options = createOptions({
      config: {
        models: {
          providers: {
            "gpu-spark": {
              baseUrl: server.baseUrl,
              timeoutSeconds: 30,
              localService: { command: process.execPath },
              models: [],
            },
          },
        },
      } as EmbeddingProviderCreateOptions["config"],
      provider: "gpu-spark",
      model: "gpu-spark/text-embedding-bge-m3",
    }) as EmbeddingProviderCreateOptions & {
      acquireLocalService: typeof acquireLocalService;
    };
    options.acquireLocalService = acquireLocalService;
    const provider = await createProvider(options);
    const controller = new AbortController();
    const callerAbort = setTimeout(() => controller.abort(), 200);

    try {
      await expect(
        withTestTimeout(
          provider.embed("hello", { inputType: "query", signal: controller.signal }),
          5_000,
          "timed out waiting for the caller abort during acquisition",
        ),
      ).rejects.toThrow("lease aborted");
    } finally {
      clearTimeout(callerAbort);
    }
  });

  it("propagates local service acquisition failures untranslated (#136405)", async () => {
    const server = await startNeverRespondingEmbeddingServer();
    const acquireLocalService = async () => {
      throw new Error("gpu-spark daemon socket gone");
    };
    const options = createOptions({
      config: {
        models: {
          providers: {
            "gpu-spark": {
              baseUrl: server.baseUrl,
              timeoutSeconds: 30,
              localService: { command: process.execPath },
              models: [],
            },
          },
        },
      } as EmbeddingProviderCreateOptions["config"],
      provider: "gpu-spark",
      model: "gpu-spark/text-embedding-bge-m3",
    }) as EmbeddingProviderCreateOptions & {
      acquireLocalService: typeof acquireLocalService;
    };
    options.acquireLocalService = acquireLocalService;
    const provider = await createProvider(options);

    const outcome = await withTestTimeout(
      provider.embed("hello", { inputType: "query" }).then(
        () => ({ type: "resolved" as const }),
        (error: unknown) => ({ type: "rejected" as const, error }),
      ),
      5_000,
      "timed out waiting for the acquisition failure",
    );
    if (outcome.type !== "rejected") {
      throw new Error(`expected acquisition failure to reject, got ${outcome.type}`);
    }
    expect((outcome.error as Error).message).toBe("gpu-spark daemon socket gone");
    expect((outcome.error as Error).name).not.toBe(EMBEDDING_STALL_TIMEOUT_ERROR_NAME);
  });

  it("does not bound labeled single-element document batches with the built-in query deadline (#136405)", async () => {
    const server = await startDelayedEmbeddingServer(11_000);
    const provider = await createProvider(createOptions({ remote: { baseUrl: server.baseUrl } }));

    // Memory Core documents single-element batches (inputType "document"):
    // indexing traffic keeps the caller's own batch bound, so the call must
    // survive past the 10s built-in query deadline and complete.
    const startedAt = Date.now();
    const outcome = await withTestTimeout(
      provider.embedBatch(["single document"], { inputType: "document" }).then(
        () => ({ type: "resolved" as const }),
        (error: unknown) => ({ type: "rejected" as const, error }),
      ),
      14_000,
      "timed out waiting for the delayed document batch",
    );
    if (outcome.type !== "resolved") {
      const error = (outcome as { error?: Error }).error;
      throw new Error(
        `expected labeled document batch to resolve, got ${outcome.type}: ${error?.message ?? ""}`,
      );
    }
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(10_500);
  }, 20_000);

  it("honors stallTimeoutSeconds as the query-lane stall deadline", async () => {
    const server = await startNeverRespondingEmbeddingServer();
    const provider = await createProvider(
      createOptions({
        config: {
          models: {
            providers: {
              "slow-embeddings": {
                baseUrl: server.baseUrl,
                stallTimeoutSeconds: 2,
                models: [],
              },
            },
          },
        } as EmbeddingProviderCreateOptions["config"],
        provider: "slow-embeddings",
        model: "text-embedding-bge-m3",
      }),
    );

    const startedAt = Date.now();
    const outcome = await withTestTimeout(
      provider.embed("hello", { inputType: "query" }).then(
        () => ({ type: "resolved" as const }),
        (error: unknown) => ({ type: "rejected" as const, error }),
      ),
      5_000,
      "timed out waiting for the configured stall deadline",
    );
    if (outcome.type !== "rejected") {
      throw new Error(`expected embedding request to reject, got ${outcome.type}`);
    }
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
    expect((outcome.error as Error).message).toBe(
      "openai-compatible embeddings request timed out after 2s",
    );
    expect((outcome.error as Error).name).toBe(EMBEDDING_STALL_TIMEOUT_ERROR_NAME);
  });

  it("keeps the configured stall deadline scoped to the provider-owned destination", async () => {
    // Provider A owns a stalled endpoint and carries a 2s stall deadline, but
    // memory.search.remote.baseUrl sends traffic to a healthy endpoint that
    // needs 3s — the knob must not cut that request off.
    const stalledServer = await startNeverRespondingEmbeddingServer();
    const healthyServer = await startDelayedEmbeddingServer(3_000);
    const provider = await createProvider(
      createOptions({
        config: {
          models: {
            providers: {
              "slow-embeddings": {
                baseUrl: stalledServer.baseUrl,
                stallTimeoutSeconds: 2,
                models: [],
              },
            },
          },
        } as EmbeddingProviderCreateOptions["config"],
        provider: "slow-embeddings",
        model: "text-embedding-bge-m3",
        remote: { baseUrl: healthyServer.baseUrl },
      }),
    );

    const startedAt = Date.now();
    await expect(
      withTestTimeout(
        provider.embed("hello", { inputType: "query" }),
        6_000,
        "timed out waiting for the healthy override endpoint",
      ),
    ).resolves.toEqual([0.1, 0.2]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
  });

  it("still honors stallTimeoutSeconds when remote.baseUrl matches the provider destination", async () => {
    const server = await startNeverRespondingEmbeddingServer();
    const provider = await createProvider(
      createOptions({
        config: {
          models: {
            providers: {
              "slow-embeddings": {
                baseUrl: server.baseUrl,
                stallTimeoutSeconds: 2,
                models: [],
              },
            },
          },
        } as EmbeddingProviderCreateOptions["config"],
        provider: "slow-embeddings",
        model: "text-embedding-bge-m3",
        remote: { baseUrl: server.baseUrl },
      }),
    );

    const startedAt = Date.now();
    const outcome = await withTestTimeout(
      provider.embed("hello", { inputType: "query" }).then(
        () => ({ type: "resolved" as const }),
        (error: unknown) => ({ type: "rejected" as const, error }),
      ),
      5_000,
      "timed out waiting for the configured stall deadline",
    );
    if (outcome.type !== "rejected") {
      throw new Error(`expected embedding request to reject, got ${outcome.type}`);
    }
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
    expect((outcome.error as Error).name).toBe(EMBEDDING_STALL_TIMEOUT_ERROR_NAME);
  });

  it("keeps labeled document batches outside the provider stall deadline even with stallTimeoutSeconds", async () => {
    const server = await startDelayedEmbeddingServer(3_000);
    const provider = await createProvider(
      createOptions({
        config: {
          models: {
            providers: {
              "slow-embeddings": {
                baseUrl: server.baseUrl,
                stallTimeoutSeconds: 2,
                models: [],
              },
            },
          },
        } as EmbeddingProviderCreateOptions["config"],
        provider: "slow-embeddings",
        model: "text-embedding-bge-m3",
      }),
    );

    // The knob overrides the query-lane default only; indexing batches keep
    // the Memory Core batch budget.
    await expect(
      withTestTimeout(
        provider.embedBatch(["doc"], { inputType: "document" }),
        6_000,
        "timed out waiting for the delayed document batch",
      ),
    ).resolves.toEqual([[0.1, 0.2]]);
  });
});
