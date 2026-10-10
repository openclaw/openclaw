// Embeddings HTTP tests cover OpenAI-compatible embedding routes, provider
// adapters, agent-scoped config, auth scopes, and disabled-surface behavior.
import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { createConfigIO, resetConfigRuntimeState } from "../config/config.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/io.js";
import type {
  EmbeddingInput,
  EmbeddingProviderCallOptions,
} from "../plugins/embedding-providers.js";
import type { MemoryEmbeddingProviderAdapter } from "../plugins/memory-embedding-providers.js";
import { createPluginRegistry } from "../plugins/registry.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { startGenericEmbeddingServer } from "./embeddings-http.test-helpers.js";
import { startOpenAiCompatGatewayServer } from "./openai-compatible-http.test-helpers.js";
import {
  installGatewayTestHooks,
  resetTestPluginRegistry,
  setTestPluginRegistry,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const WRITE_SCOPE_HEADER = { "x-openclaw-scopes": "operator.write" };

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let createEmbeddingProviderMock: ReturnType<
  typeof vi.fn<
    (options: {
      provider: string;
      model: string;
      agentDir?: string;
      dimensions?: number;
      acquireLocalService?: unknown;
    }) => Promise<{
      provider: {
        id: string;
        model: string;
        embed: (input: EmbeddingInput, options?: EmbeddingProviderCallOptions) => Promise<number[]>;
        embedBatch: (
          inputs: EmbeddingInput[],
          options?: EmbeddingProviderCallOptions,
        ) => Promise<number[][]>;
        close?: () => Promise<void> | void;
      };
    }>
  >
>;
let embedBatchMock: ReturnType<
  typeof vi.fn<
    (inputs: EmbeddingInput[], options?: EmbeddingProviderCallOptions) => Promise<number[][]>
  >
>;
let closeEmbeddingProviderMock: ReturnType<typeof vi.fn<() => Promise<void> | void>>;
let openAiAdapter: MemoryEmbeddingProviderAdapter;
let drainRetainedOpenAiEmbeddingProviders: typeof import("./embeddings-provider-lifetime.js").drainRetainedOpenAiEmbeddingProviders;
let clearEmbeddingProviders: typeof import("../plugins/embedding-providers.js").clearEmbeddingProviders;
let registerEmbeddingProvider: typeof import("../plugins/embedding-providers.js").registerEmbeddingProvider;
let enabledServer: Awaited<ReturnType<typeof startOpenAiCompatGatewayServer>>;
let genericEmbeddingServer: Awaited<ReturnType<typeof startGenericEmbeddingServer>>;
let enabledPort: number;
let genericEmbeddingBaseUrl: string;
const providerGateReleases = new Set<() => void>();

beforeAll(async () => {
  ({ drainRetainedOpenAiEmbeddingProviders } = await import("./embeddings-provider-lifetime.js"));
  ({ clearEmbeddingProviders, registerEmbeddingProvider } =
    await import("../plugins/embedding-providers.js"));
  embedBatchMock = vi.fn(async (inputs: EmbeddingInput[]) =>
    inputs.map((_input, index) => [index + 0.1, index + 0.2]),
  );
  closeEmbeddingProviderMock = vi.fn(async () => {});
  createEmbeddingProviderMock = vi.fn(
    async (options: { provider: string; model: string; agentDir?: string }) => ({
      provider: {
        id: options.provider,
        model: options.model,
        embed: async () => [0.1, 0.2],
        embedBatch: embedBatchMock,
        close: closeEmbeddingProviderMock,
      },
    }),
  );
  genericEmbeddingServer = await startGenericEmbeddingServer();
  genericEmbeddingBaseUrl = genericEmbeddingServer.baseUrl;
  openAiAdapter = {
    id: "openai",
    defaultModel: "text-embedding-3-small",
    transport: "remote",
    autoSelectPriority: 20,
    allowExplicitWhenConfiguredAuto: true,
    create: async (options) => {
      const localServiceOptions = options as typeof options & {
        acquireLocalService?: unknown;
      };
      const result = await createEmbeddingProviderMock({
        provider: options.provider ?? "openai",
        model: options.model,
        agentDir: options.agentDir,
        dimensions: options.dimensions,
        acquireLocalService: localServiceOptions.acquireLocalService,
      });
      return result;
    },
  };
  ({ startGatewayServer } = await import("./server.js"));
  const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  enabledPort = portClaim.port;
  enabledServer = await startOpenAiCompatGatewayServer({
    startGatewayServer,
    port: portClaim,
    auth: { mode: "token", token: "secret" },
    openAiChatCompletionsEnabled: true,
  });
});

beforeEach(async () => {
  await writeEmbeddingConfig({});
  const builder = createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: true,
  });
  setTestPluginRegistry(builder.registry);
  registerEmbeddingProvider(openAiAdapter);
});

afterEach(async () => {
  // Vitest can finish a timed-out case while its provider is still awaiting a fixture gate.
  for (const release of providerGateReleases) {
    release();
  }
  providerGateReleases.clear();
  await drainRetainedOpenAiEmbeddingProviders();
  // Pending cleanup must consume its implementation before queued fixture behavior is reset.
  createEmbeddingProviderMock.mockReset();
  embedBatchMock.mockReset();
  closeEmbeddingProviderMock.mockReset();
  Reflect.set(openAiAdapter, "transport", "remote");
  clearEmbeddingProviders();
  resetTestPluginRegistry();
});

afterAll(async () => {
  await enabledServer.close({ reason: "embeddings http enabled suite done" });
  await genericEmbeddingServer.close();
  vi.resetModules();
});

async function waitForProviderEntry(started: Promise<void>, request: Promise<Response>) {
  await Promise.race([
    started,
    request.then((response) => {
      throw new Error(`Embedding request completed before provider entry (${response.status})`);
    }),
  ]);
}

function createProviderGate() {
  const gate = createDeferred();
  providerGateReleases.add(gate.resolve);
  return gate;
}

async function postEmbeddings(body: unknown, headers?: Record<string, string>) {
  return await fetch(`http://127.0.0.1:${enabledPort}/v1/embeddings`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
      ...WRITE_SCOPE_HEADER,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function writeEmbeddingConfig(config: Record<string, unknown>) {
  const configPath = createConfigIO().configPath;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config));
  resetConfigRuntimeState();
}

async function expectDefaultEmbeddingResponse(res: Response) {
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    object?: string;
    data?: Array<{ object?: string; embedding?: number[] }>;
    usage?: { prompt_tokens: number; total_tokens: number };
  };
  expect(json.object).toBe("list");
  expect(json.data?.[0]?.object).toBe("embedding");
  expect(json.data?.[0]?.embedding).toEqual([0.1, 0.2]);
  expect(json.usage).toEqual({ prompt_tokens: 0, total_tokens: 0 });
}

async function expectEmbeddingData(
  res: Response,
  expected: Array<{ object: "embedding"; index: number; embedding: number[] }>,
) {
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
    usage?: { prompt_tokens: number; total_tokens: number };
  };
  expect(json.data).toEqual(expected);
  return json;
}

async function expectInvalidEmbeddingRequest(res: Response, message?: string) {
  expect(res.status).toBe(400);
  const json = (await res.json()) as { error?: { type?: string; message?: string } };
  if (message === undefined) {
    expect(json.error?.type).toBe("invalid_request_error");
    return;
  }
  expect(json.error).toEqual({
    type: "invalid_request_error",
    message,
  });
}

async function expectGenericProviderEmbeddingRequest(expectedProviderCall: {
  model: string;
  dimensions: number;
  inputType: string;
  override?: string;
}) {
  const res = await postEmbeddings(
    { model: "openclaw/default", input: ["a", "b"] },
    expectedProviderCall.override
      ? { "x-openclaw-model": expectedProviderCall.override }
      : undefined,
  );
  const json = await expectEmbeddingData(res, [
    { object: "embedding", index: 0, embedding: [9.1, 9.2] },
    { object: "embedding", index: 1, embedding: [10.1, 9.2] },
  ]);
  expect(json.usage).toEqual({ prompt_tokens: 777, total_tokens: 778 });
  expect(genericEmbeddingServer.requests.at(-1)?.body).toMatchObject({
    model: expectedProviderCall.model,
    dimensions: expectedProviderCall.dimensions,
    input_type: expectedProviderCall.inputType,
  });
}

function latestCreateEmbeddingProviderOptions(): {
  agentDir?: string;
  model?: string;
  provider?: string;
  acquireLocalService?: unknown;
} {
  const calls = createEmbeddingProviderMock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected embedding provider create call");
  }
  return call[0];
}

describe("OpenAI-compatible embeddings HTTP API (e2e)", () => {
  it("embeds string and array inputs", async () => {
    const closesBefore = closeEmbeddingProviderMock.mock.calls.length;
    const single = await postEmbeddings({
      model: "openclaw/default",
      input: "hello",
    });
    await expectDefaultEmbeddingResponse(single);

    const batch = await postEmbeddings({
      model: "openclaw/default",
      input: ["a", "b"],
    });
    await expectEmbeddingData(batch, [
      { object: "embedding", index: 0, embedding: [0.1, 0.2] },
      { object: "embedding", index: 1, embedding: [1.1, 1.2] },
    ]);

    const qualified = await postEmbeddings(
      {
        model: "openclaw/default",
        input: "hello again",
      },
      { "x-openclaw-model": "openai/text-embedding-3-small" },
    );
    expect(qualified.status).toBe(200);
    const qualifiedJson = (await qualified.json()) as { model?: string };
    expect(qualifiedJson.model).toBe("openclaw/default");
    const lastCall = latestCreateEmbeddingProviderOptions();
    expect(lastCall.provider).toBe("openai");
    expect(lastCall.model).toBe("text-embedding-3-small");
    expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(closesBefore + 3);
  });

  it.each([
    {
      reports: [
        { promptTokens: 2, totalTokens: 3 },
        { promptTokens: 5, totalTokens: 6 },
      ],
      expected: { prompt_tokens: 7, total_tokens: 9 },
    },
    {
      reports: [undefined, { promptTokens: 5, totalTokens: 6 }],
      expected: { prompt_tokens: 0, total_tokens: 0 },
    },
    {
      reports: [{ promptTokens: 2, totalTokens: 3 }, undefined],
      expected: { prompt_tokens: 0, total_tokens: 0 },
    },
  ])("reports complete usage for split batches: $reports", async ({ reports, expected }) => {
    embedBatchMock.mockImplementationOnce(async (_inputs, options) => {
      for (const report of reports) {
        options?.onUsage?.(report);
      }
      return [
        [0.1, 0.2],
        [1.1, 1.2],
      ];
    });
    const response = await postEmbeddings({ model: "openclaw/default", input: ["a", "b"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ usage: expected });
  });

  it("supports base64 encoding and agent-scoped auth/config resolution", async () => {
    try {
      testState.agentsConfig = { entries: { main: {}, beta: {} } };
      resetConfigRuntimeState();

      const res = await postEmbeddings(
        {
          model: "openclaw/beta",
          input: "hello",
          encoding_format: "base64",
        },
        { "x-openclaw-agent-id": "beta" },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data?: Array<{ embedding?: string }> };
      expect(typeof json.data?.[0]?.embedding).toBe("string");
      expect(createEmbeddingProviderMock).toHaveBeenCalled();
      const lastCall = latestCreateEmbeddingProviderOptions();
      expect(typeof lastCall.model).toBe("string");
      expect(lastCall.agentDir).toBe(resolveAgentDir({}, "beta"));
    } finally {
      testState.agentsConfig = undefined;
      resetConfigRuntimeState();
    }
  });

  it.each([
    { enabled: false, dimensions: 8, expected: 8 },
    { enabled: false, dimensions: undefined, expected: undefined },
    { enabled: true, dimensions: undefined, expected: 16 },
  ])(
    "passes dimensions=$dimensions with memory search enabled=$enabled",
    async ({ enabled, dimensions, expected }) => {
      await writeEmbeddingConfig({ memory: { search: { enabled, outputDimensionality: 16 } } });

      const res = await postEmbeddings({
        model: "openclaw/default",
        input: "hello",
        dimensions,
      });

      await expectDefaultEmbeddingResponse(res);
      expect(createEmbeddingProviderMock.mock.calls.at(-1)?.[0].dimensions).toBe(expected);
    },
  );

  it("rejects explicit unknown agent ids", async () => {
    try {
      testState.agentsConfig = { ownership: "explicit", entries: { main: {}, beta: {} } };
      resetConfigRuntimeState();

      const missing = await postEmbeddings({ model: "openclaw", input: "hello" });
      expect(missing.status).toBe(400);
      const missingJson = (await missing.json()) as {
        error?: { type?: string; message?: string };
      };
      expect(missingJson.error?.type).toBe("invalid_request_error");
      expect(missingJson.error?.message).toContain("has no explicit owner");

      const header = await postEmbeddings(
        { model: "openclaw/default", input: "hello" },
        { "x-openclaw-agent-id": "missing-agent" },
      );
      await expectInvalidEmbeddingRequest(header, "Unknown agent 'missing-agent'.");

      const model = await postEmbeddings({ model: "openclaw/missing-agent", input: "hello" });
      await expectInvalidEmbeddingRequest(model, "Unknown agent 'missing-agent'.");
    } finally {
      testState.agentsConfig = undefined;
      resetConfigRuntimeState();
    }
  });

  it.each([{ name: "unsupported encoding", option: { encoding_format: "hex" } }])(
    "rejects $name before creating an embedding provider",
    async ({ option }) => {
      const providersCreatedBefore = createEmbeddingProviderMock.mock.calls.length;
      const res = await postEmbeddings({ model: "openclaw/default", input: "hello", ...option });

      await expectInvalidEmbeddingRequest(res);
      expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(providersCreatedBefore);
    },
  );

  it.each([
    { name: "an empty batch", input: [] },
    { name: "a mixed batch with an empty entry", input: ["valid", ""] },
  ])("rejects $name before creating an embedding provider", async ({ input }) => {
    const providersCreatedBefore = createEmbeddingProviderMock.mock.calls.length;
    const res = await postEmbeddings({
      model: "openclaw/default",
      input,
    });

    await expectInvalidEmbeddingRequest(res, "`input` must contain at least one non-empty string.");
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(providersCreatedBefore);
  });

  it("ignores narrower declared scopes for shared-secret bearer auth", async () => {
    const res = await postEmbeddings(
      {
        model: "openclaw/default",
        input: "hello",
      },
      { "x-openclaw-scopes": "operator.read" },
    );
    await expectDefaultEmbeddingResponse(res);
  });

  it.each([
    { model: "nomic-embed-text", override: undefined },
    { model: "library/bge-m3", override: undefined },
    { model: "nomic-embed-text", override: "hf:org/model" },
  ])(
    "routes embedding model $model with override $override through the configured provider",
    async ({ model, override }) => {
      await writeEmbeddingConfig({
        memory: {
          search: {
            provider: "openai-compatible",
            model,
            inputType: "default",
            queryInputType: "query",
            documentInputType: "document",
            outputDimensionality: 768,
            remote: { baseUrl: genericEmbeddingBaseUrl },
          },
        },
      });

      await expectGenericProviderEmbeddingRequest({
        model: override ?? model,
        override,
        dimensions: 768,
        inputType: "document",
      });
    },
  );

  it("rejects invalid agent targets", async () => {
    const res = await postEmbeddings({
      model: "ollama/nomic-embed-text",
      input: "hello",
    });
    await expectInvalidEmbeddingRequest(
      res,
      "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
    );
  });

  it("rejects disallowed x-openclaw-model provider overrides", async () => {
    registerEmbeddingProvider({
      id: "ollama",
      transport: "remote",
      create: async () => ({ provider: null }),
    });
    const res = await postEmbeddings(
      {
        model: "openclaw/default",
        input: "hello",
      },
      { "x-openclaw-model": "ollama/nomic-embed-text" },
    );
    await expectInvalidEmbeddingRequest(
      res,
      "This agent does not allow that embedding provider on `/v1/embeddings`.",
    );
  });

  it("enforces trusted-proxy embedding scopes before provider work", async () => {
    await withEnvAsync(
      { OPENCLAW_GATEWAY_TOKEN: undefined, OPENCLAW_GATEWAY_PASSWORD: undefined },
      async () => {
        const previousAuth = testState.gatewayAuth;
        const auth = {
          mode: "trusted-proxy" as const,
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowLoopback: true,
          },
        };
        testState.gatewayAuth = auth;
        let server: Awaited<ReturnType<typeof startOpenAiCompatGatewayServer>> | undefined;
        try {
          await writeEmbeddingConfig({
            gateway: {
              auth,
              trustedProxies: ["127.0.0.1"],
              roles: {
                default: "reader",
                definitions: {
                  reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
                  writer: { agents: "*", scopes: ["operator.write"], sessions: { others: "view" } },
                },
              },
            },
          });
          const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
          server = await startOpenAiCompatGatewayServer({
            startGatewayServer,
            port: portClaim,
            auth,
            openAiChatCompletionsEnabled: true,
          });
          registerEmbeddingProvider(openAiAdapter);
          for (const role of ["reader", "writer"]) {
            setUserProfileRole(ensureProfileForEmail(`${role}@embeddings.example.test`).id, role);
          }
          const post = (role: "reader" | "writer", override?: string) =>
            fetch(`http://127.0.0.1:${portClaim.port}/v1/embeddings`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-forwarded-for": "198.51.100.42",
                "x-forwarded-proto": "https",
                "x-forwarded-user": `${role}@embeddings.example.test`,
                "x-openclaw-scopes": role === "reader" ? "operator.read" : "operator.write",
                ...(override ? { "x-openclaw-model": override } : {}),
              },
              body: JSON.stringify({ model: "openclaw/default", input: "hello" }),
            });
          createEmbeddingProviderMock.mockClear();
          embedBatchMock.mockClear();
          const denied = await post("reader");
          expect({
            status: denied.status,
            providersCreated: createEmbeddingProviderMock.mock.calls.length,
            embeddingCalls: embedBatchMock.mock.calls.length,
          }).toEqual({ status: 403, providersCreated: 0, embeddingCalls: 0 });
          expect(await denied.json()).toMatchObject({
            error: { type: "forbidden", message: "missing scope: operator.write" },
          });

          await expectDefaultEmbeddingResponse(await post("writer"));
          expect(createEmbeddingProviderMock).toHaveBeenCalledOnce();
          expect(embedBatchMock).toHaveBeenCalledOnce();

          const override = await post("writer", "openai/text-embedding-3-small");
          expect(override.status).toBe(403);
          expect(await override.json()).toMatchObject({
            error: { type: "forbidden", message: "missing scope: operator.admin" },
          });
          expect(createEmbeddingProviderMock).toHaveBeenCalledOnce();
          expect(embedBatchMock).toHaveBeenCalledOnce();
        } finally {
          try {
            await server?.close({ reason: "embeddings scope admission test done" });
          } finally {
            testState.gatewayAuth = previousAuth;
            await writeEmbeddingConfig({});
          }
        }
      },
    );
  });

  it("rejects oversized batches", async () => {
    const res = await postEmbeddings({
      model: "openclaw/default",
      input: Array.from({ length: 129 }, () => "x"),
    });
    await expectInvalidEmbeddingRequest(res, "Too many inputs (max 128).");
  });

  it("sanitizes provider failures", async () => {
    createEmbeddingProviderMock.mockRejectedValueOnce(new Error("secret upstream failure"));
    const res = await postEmbeddings({
      model: "openclaw/default",
      input: "hello",
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error).toEqual({
      type: "api_error",
      message: "internal error",
    });
  });

  it.each([
    {
      phase: "setup",
      message:
        'No API key found for provider "openai". Configure an API key (openclaw models auth paste-api-key --provider openai).',
      status: 401,
      type: "authentication_error",
    },
    {
      phase: "embedding",
      message: "503 service unavailable",
      status: 503,
      type: "api_error",
      publicMessage: "upstream provider overloaded",
    },
  ])(
    "maps $phase failure to $status $type",
    async ({ phase, message, status, type, publicMessage }) => {
      const failingOperation = phase === "setup" ? createEmbeddingProviderMock : embedBatchMock;
      failingOperation.mockRejectedValueOnce(new Error(message));

      const res = await postEmbeddings({ model: "openclaw/default", input: "hello" });

      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: { type, message: publicMessage ?? message } });
    },
  );

  it("redacts credentials in actionable provider errors", async () => {
    const credential = "sk-test-embedding-error-fixture-1234567890";
    embedBatchMock.mockRejectedValueOnce(new Error(`Incorrect API key provided: ${credential}`));

    const res = await postEmbeddings({ model: "openclaw/default", input: "hello" });

    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { type: string; message: string } };
    expect(json.error.type).toBe("authentication_error");
    expect(json.error.message).toContain("Incorrect API key provided:");
    expect(json.error.message).not.toContain(credential);
  });

  it.each(["provider acquisition", "embedding"] as const)(
    "revalidates admission without canceling accepted work when policy changes during %s",
    async (phase) => {
      const operationStarted = createDeferred();
      const releaseOperation = createDeferred();
      const waitForPolicyChange = async () => {
        operationStarted.resolve();
        await releaseOperation.promise;
      };
      const embed = vi.fn(async () => {
        if (phase === "embedding") {
          await waitForPolicyChange();
        }
        return [[0.1, 0.2]];
      });
      const closed = createDeferred();
      const close = vi.fn(() => closed.resolve());
      createEmbeddingProviderMock.mockImplementationOnce(async (options) => {
        if (phase === "provider acquisition") {
          await waitForPolicyChange();
        }
        return {
          provider: {
            id: options.provider,
            model: options.model,
            embed: async () => [0.1, 0.2],
            embedBatch: embed,
            close,
          },
        };
      });
      const cfg = getRuntimeConfig();
      const pending = postEmbeddings({ model: "openclaw/default", input: "hello" });
      try {
        await operationStarted.promise;
        setRuntimeConfigSnapshot({
          ...cfg,
          gateway: {
            ...cfg.gateway,
            allowRealIpFallback: !cfg.gateway?.allowRealIpFallback,
          },
        });
        releaseOperation.resolve();

        const response = await pending;
        if (phase === "provider acquisition") {
          expect(response.status).toBe(401);
          expect(embed).not.toHaveBeenCalled();
        } else {
          await expectDefaultEmbeddingResponse(response);
        }
        await closed.promise;
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        releaseOperation.resolve();
        await pending;
        setRuntimeConfigSnapshot(cfg);
      }
    },
  );

  it("aborts provider work when the HTTP client disconnects", async () => {
    const closesBefore = closeEmbeddingProviderMock.mock.calls.length;
    let receivedSignal: AbortSignal | undefined;
    const embedStarted = createDeferred();
    const releaseEmbed = createDeferred();
    embedBatchMock.mockImplementationOnce(async (_texts, options) => {
      const signal = options?.signal;
      receivedSignal = signal;
      embedStarted.resolve();
      await (signal
        ? new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          })
        : releaseEmbed.promise);
      return [[0.1, 0.2]];
    });

    const body = JSON.stringify({ model: "openclaw/default", input: "hello" });
    const clientRequest = httpRequest({
      host: "127.0.0.1",
      port: enabledPort,
      path: "/v1/embeddings",
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...WRITE_SCOPE_HEADER,
      },
    });
    clientRequest.on("error", () => {});
    clientRequest.end(body);

    await embedStarted.promise;
    clientRequest.destroy();

    try {
      await vi.waitFor(() => {
        expect(receivedSignal).toBeDefined();
        expect(receivedSignal?.aborted).toBe(true);
      });
    } finally {
      releaseEmbed.resolve();
    }
    await vi.waitFor(() =>
      expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(closesBefore + 1),
    );
  });

  it("retains failed cleanup and blocks replacement until retirement succeeds", async () => {
    const createsBefore = createEmbeddingProviderMock.mock.calls.length;
    closeEmbeddingProviderMock
      .mockRejectedValueOnce(new Error("first close failed"))
      .mockRejectedValueOnce(new Error("retry close failed"));

    const first = await postEmbeddings({ model: "openclaw/default", input: "first" });
    expect(first.status).toBe(200);
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 1);

    const blocked = await postEmbeddings({ model: "openclaw/default", input: "blocked" });
    expect(blocked.status).toBe(500);
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 1);

    const recovered = await postEmbeddings({ model: "openclaw/default", input: "recovered" });
    expect(recovered.status).toBe(200);
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 2);
  });

  it.each([
    { kind: "local provider", localProvider: false, modelOverride: false, closeFails: true },
    {
      kind: "created local provider",
      localProvider: true,
      modelOverride: false,
      closeFails: false,
    },
    { kind: "model override", localProvider: false, modelOverride: true, closeFails: false },
  ])(
    "does not bypass pending cleanup with $kind",
    async ({ localProvider, modelOverride, closeFails }) => {
      const lifetime = await import("./embeddings-provider-lifetime.js");
      const acquireLease = lifetime.acquireEmbeddingProviderLease;
      const acquireLeaseSpy = vi.spyOn(lifetime, "acquireEmbeddingProviderLease");
      Reflect.set(openAiAdapter, "transport", localProvider ? "remote" : "local");
      const closeStarted = createDeferred();
      const { promise: closeGate, resolve: releaseClose } = createProviderGate();
      closeEmbeddingProviderMock.mockImplementationOnce(async () => {
        closeStarted.resolve();
        await closeGate;
        if (closeFails) {
          throw new Error("close failed");
        }
      });
      if (localProvider) {
        registerEmbeddingProvider({ ...openAiAdapter, id: "local", transport: "local" });
        createEmbeddingProviderMock.mockResolvedValueOnce({
          provider: {
            id: "local",
            model: "local-embed",
            embed: async () => [0.1, 0.2],
            embedBatch: embedBatchMock,
            close: closeEmbeddingProviderMock,
          },
        });
      }
      const createsBefore = createEmbeddingProviderMock.mock.calls.length;
      const closesBefore = closeEmbeddingProviderMock.mock.calls.length;
      // Concurrent provider admission needs distinct connections; each socket owns serial requests.
      const firstPromise = postEmbeddings(
        { model: "openclaw/default", input: "first" },
        {
          connection: "close",
          ...(modelOverride ? { "x-openclaw-model": "openai/model-a" } : {}),
        },
      );
      const requests = [firstPromise];
      try {
        await waitForProviderEntry(closeStarted.promise, firstPromise);
        expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(closesBefore + 1);
        const secondEntered = createDeferred();
        acquireLeaseSpy.mockImplementationOnce((...args) => {
          const lease = acquireLease(...args);
          secondEntered.resolve();
          return lease;
        });
        const secondPromise = postEmbeddings(
          { model: "openclaw/default", input: "second" },
          {
            connection: "close",
            ...(modelOverride ? { "x-openclaw-model": "openai/model-b" } : {}),
          },
        );
        requests.push(secondPromise);
        await waitForProviderEntry(secondEntered.promise, secondPromise);
        expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 1);

        releaseClose();
        const [first, second] = await Promise.all([firstPromise, secondPromise]);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 2);
      } finally {
        releaseClose();
        try {
          await Promise.allSettled(requests);
          await drainRetainedOpenAiEmbeddingProviders();
        } finally {
          acquireLeaseSpy.mockRestore();
          Reflect.set(openAiAdapter, "transport", "remote");
        }
      }
    },
  );

  it("does not create a provider for a disconnected request waiting behind cleanup", async () => {
    const lifetime = await import("./embeddings-provider-lifetime.js");
    const acquireLease = lifetime.acquireEmbeddingProviderLease;
    const acquireLeaseSpy = vi.spyOn(lifetime, "acquireEmbeddingProviderLease");
    Reflect.set(openAiAdapter, "transport", "local");
    const { promise: closeGate, resolve: releaseClose } = createProviderGate();
    const closeStarted = createDeferred();
    closeEmbeddingProviderMock.mockImplementationOnce(async () => {
      closeStarted.resolve();
      await closeGate;
    });
    const createsBefore = createEmbeddingProviderMock.mock.calls.length;
    const closesBefore = closeEmbeddingProviderMock.mock.calls.length;
    const firstPromise = postEmbeddings({ model: "openclaw/default", input: "first" });
    let secondRequest: ReturnType<typeof httpRequest> | undefined;

    try {
      await waitForProviderEntry(closeStarted.promise, firstPromise);
      expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(closesBefore + 1);
      const queued = createDeferred<AbortSignal>();
      acquireLeaseSpy.mockImplementationOnce((...args) => {
        const lease = acquireLease(...args);
        queued.resolve(args[1]);
        return lease;
      });

      const body = JSON.stringify({ model: "openclaw/default", input: "second" });
      const request = httpRequest({
        host: "127.0.0.1",
        port: enabledPort,
        path: "/v1/embeddings",
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...WRITE_SCOPE_HEADER,
        },
      });
      secondRequest = request;
      const unexpectedResponse = new Promise<never>((_resolve, reject) => {
        request.once("error", reject);
        request.once("response", (response) => {
          response.resume();
          reject(new Error(`Queued request completed before admission (${response.statusCode})`));
        });
      });
      const secondRequestClosed = createDeferred();
      secondRequest.once("close", secondRequestClosed.resolve);
      secondRequest.end(body);
      const signal = await Promise.race([queued.promise, unexpectedResponse]);
      const aborted = createDeferred();
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      secondRequest.destroy();
      await aborted.promise;
      await secondRequestClosed.promise;

      releaseClose();
      expect((await firstPromise).status).toBe(200);

      const next = await postEmbeddings({ model: "openclaw/default", input: "next" });
      expect(next.status).toBe(200);
      expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 2);
    } finally {
      releaseClose();
      secondRequest?.destroy();
      try {
        await Promise.allSettled([firstPromise]);
        await drainRetainedOpenAiEmbeddingProviders();
      } finally {
        acquireLeaseSpy.mockRestore();
        Reflect.set(openAiAdapter, "transport", "remote");
      }
    }
  });

  it("allows providers without cleanup resources to embed concurrently", async () => {
    const { promise: firstEmbedGate, resolve: releaseFirstEmbed } = createProviderGate();
    const firstEmbedStarted = createDeferred();
    const firstEmbed = vi.fn(async () => {
      firstEmbedStarted.resolve();
      await firstEmbedGate;
      return [[1, 2]];
    });
    const secondEmbed = vi.fn(async () => [[3, 4]]);
    createEmbeddingProviderMock
      .mockResolvedValueOnce({
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embed: async () => [1, 2],
          embedBatch: firstEmbed,
          close: vi.fn(async () => {}),
        },
      })
      .mockResolvedValueOnce({
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embed: async () => [3, 4],
          embedBatch: secondEmbed,
          close: vi.fn(async () => {}),
        },
      });

    const firstPromise = postEmbeddings({ model: "openclaw/default", input: "first" });
    const requests = [firstPromise];
    try {
      await waitForProviderEntry(firstEmbedStarted.promise, firstPromise);
      expect(firstEmbed).toHaveBeenCalledTimes(1);
      const secondPromise = postEmbeddings({ model: "openclaw/default", input: "second" });
      requests.push(secondPromise);
      const second = await secondPromise;
      expect(second.status).toBe(200);
      expect(secondEmbed).toHaveBeenCalledTimes(1);

      releaseFirstEmbed();
      expect((await firstPromise).status).toBe(200);
    } finally {
      releaseFirstEmbed();
      await Promise.allSettled(requests);
      createEmbeddingProviderMock.mockReset();
    }
  });

  it("drains retained provider cleanup during gateway shutdown", async () => {
    const closesBefore = closeEmbeddingProviderMock.mock.calls.length;
    closeEmbeddingProviderMock.mockRejectedValueOnce(new Error("close failed"));

    const res = await postEmbeddings({ model: "openclaw/default", input: "hello" });
    expect(res.status).toBe(200);

    await drainRetainedOpenAiEmbeddingProviders();
    expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(closesBefore + 2);
  });
});
