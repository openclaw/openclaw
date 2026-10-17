import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  captureRuntimeConfigAsyncReader,
  createConfigIO,
  resetConfigRuntimeState,
} from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { EmbeddingInput } from "../plugins/embedding-providers.js";
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
} from "../plugins/memory-embedding-providers.js";
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
const INPUT_ERROR = "`input` must contain at least one non-empty string.";
const USAGE_A = { promptTokens: 2, totalTokens: 3 };
const USAGE_B = { promptTokens: 5, totalTokens: 6 };
const ZERO_USAGE = { prompt_tokens: 0, total_tokens: 0 };
const MISSING_KEY =
  'No API key found for provider "openai". Configure an API key (openclaw models auth paste-api-key --provider openai).';

let startGatewayServer: typeof import("./server.js").startGatewayServer;
type ProviderOptions = {
  provider: string;
  model: string;
  agentDir?: string;
  dimensions?: number;
};
const createProvider = vi.fn(async (options: ProviderOptions) =>
  makeProvider({ id: options.provider, model: options.model }),
);
let embedBatch: ReturnType<typeof vi.fn<MemoryEmbeddingProvider["embedBatch"]>>;
const closeProvider = vi.fn<() => Promise<void> | void>(async () => {});
let openAiAdapter: MemoryEmbeddingProviderAdapter;
let drainRetainedOpenAiEmbeddingProviders: typeof import("./embeddings-provider-lifetime.js").drainRetainedOpenAiEmbeddingProviders;
let clearEmbeddingProviders: typeof import("../plugins/embedding-providers.js").clearEmbeddingProviders;
let registerEmbeddingProvider: typeof import("../plugins/embedding-providers.js").registerEmbeddingProvider;
let enabledServer: Awaited<ReturnType<typeof startOpenAiCompatGatewayServer>>;
let genericEmbeddingServer: Awaited<ReturnType<typeof startGenericEmbeddingServer>>;
let enabledPort: number;
const providerGateReleases = new Set<() => void>();

beforeAll(async () => {
  ({ drainRetainedOpenAiEmbeddingProviders } = await import("./embeddings-provider-lifetime.js"));
  ({ clearEmbeddingProviders, registerEmbeddingProvider } =
    await import("../plugins/embedding-providers.js"));
  embedBatch = vi.fn(async (inputs: EmbeddingInput[]) =>
    inputs.map((_input, index) => [index + 0.1, index + 0.2]),
  );
  genericEmbeddingServer = await startGenericEmbeddingServer();
  openAiAdapter = {
    id: "openai",
    defaultModel: "text-embedding-3-small",
    transport: "remote",
    autoSelectPriority: 20,
    allowExplicitWhenConfiguredAuto: true,
    create: async (options) =>
      await createProvider({
        provider: options.provider ?? "openai",
        model: options.model,
        agentDir: options.agentDir,
        dimensions: options.dimensions,
      }),
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
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: true,
  });
  setTestPluginRegistry(builder.registry);
  registerEmbeddingProvider(openAiAdapter);
});

afterEach(async () => {
  testState.agentsConfig = undefined;
  resetConfigRuntimeState();
  // Vitest can finish a timed-out case while its provider is still awaiting a fixture gate.
  for (const release of providerGateReleases) {
    release();
  }
  providerGateReleases.clear();
  await drainRetainedOpenAiEmbeddingProviders();
  // Pending cleanup must consume its implementation before queued fixture behavior is reset.
  [createProvider, embedBatch, closeProvider].forEach((mock) => mock.mockReset());
  Reflect.set(openAiAdapter, "transport", "remote");
  clearEmbeddingProviders();
  resetTestPluginRegistry();
});

afterAll(async () => {
  await enabledServer.close({ reason: "embeddings http enabled suite done" });
  await genericEmbeddingServer.close();
  vi.resetModules();
});

async function waitForProviderEntry(started: Promise<unknown>, request: Promise<Response>) {
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

async function pendingCleanup(localProvider = false) {
  const lifetime = await import("./embeddings-provider-lifetime.js");
  const acquire = lifetime.acquireEmbeddingProviderLease;
  const spy = vi.spyOn(lifetime, "acquireEmbeddingProviderLease");
  Reflect.set(openAiAdapter, "transport", localProvider ? "remote" : "local");
  const started = createDeferred();
  const gate = createProviderGate();
  let finished = false;
  closeProvider.mockImplementationOnce(async () => {
    started.resolve();
    await gate.promise;
    finished = true;
  });
  const requests: Promise<Response>[] = [];
  return {
    started: started.promise,
    release: gate.resolve,
    finished: () => finished,
    requests,
    watchAdmission() {
      const queued = createDeferred<AbortSignal>();
      spy.mockImplementationOnce((...args) => {
        const lease = acquire(...args);
        queued.resolve(args[1]);
        return lease;
      });
      return queued.promise;
    },
    async [Symbol.asyncDispose]() {
      gate.resolve();
      try {
        await Promise.allSettled(requests);
        await drainRetainedOpenAiEmbeddingProviders();
      } finally {
        spy.mockRestore();
        Reflect.set(openAiAdapter, "transport", "remote");
      }
    },
  };
}

const makeProvider = (overrides: Partial<MemoryEmbeddingProvider> = {}) => ({
  provider: {
    id: "openai",
    model: "text-embedding-3-small",
    embed: async () => [0.1, 0.2],
    embedBatch,
    close: closeProvider,
    ...overrides,
  },
});

const embeddingBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ model: "openclaw/default", input: "hello", ...overrides });

const embeddingHeaders = (headers?: Record<string, string>) => ({
  authorization: "Bearer secret",
  "content-type": "application/json",
  ...WRITE_SCOPE_HEADER,
  ...headers,
});

async function post(body: Record<string, unknown> = {}, headers?: Record<string, string>) {
  return await fetch(`http://127.0.0.1:${enabledPort}/v1/embeddings`, {
    method: "POST",
    headers: embeddingHeaders(headers),
    body: embeddingBody(body),
  });
}

function rawEmbeddingRequest(input: string) {
  const body = embeddingBody({ input });
  const request = httpRequest({
    host: "127.0.0.1",
    port: enabledPort,
    path: "/v1/embeddings",
    method: "POST",
    headers: embeddingHeaders({ "content-length": String(Buffer.byteLength(body)) }),
  });
  return { request, body };
}

async function writeEmbeddingConfig(config: Record<string, unknown>) {
  const configPath = createConfigIO().configPath;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config));
  resetConfigRuntimeState();
}

type EmbeddingsResponse = {
  object?: string;
  data?: Array<{ object?: string; embedding?: number[]; index?: number }>;
  usage?: { prompt_tokens: number; total_tokens: number };
};

async function expectDefaultResponse(res: Response) {
  expect(res.status).toBe(200);
  const json = (await res.json()) as EmbeddingsResponse;
  expect(json.object).toBe("list");
  expect(json.data?.[0]).toMatchObject({ object: "embedding", embedding: [0.1, 0.2] });
  expect(json.usage).toEqual(ZERO_USAGE);
}

async function expectEmbeddingData(
  res: Response,
  expected: Array<{ object: "embedding"; index: number; embedding: number[] }>,
) {
  expect(res.status).toBe(200);
  const json = (await res.json()) as EmbeddingsResponse;
  expect(json.data).toEqual(expected);
  return json;
}

async function expectInvalidRequest(res: Response, message?: string) {
  expect(res.status).toBe(400);
  const json = (await res.json()) as { error?: { type?: string; message?: string } };
  if (message === undefined) {
    expect(json.error?.type).toBe("invalid_request_error");
    return;
  }
  expect(json.error).toEqual({ type: "invalid_request_error", message });
}

describe("OpenAI-compatible embeddings HTTP API (e2e)", () => {
  it("embeds string and array inputs", async () => {
    await expectDefaultResponse(await post());
    const batch = await post({ input: ["a", "b"] });
    await expectEmbeddingData(batch, [
      { object: "embedding", index: 0, embedding: [0.1, 0.2] },
      { object: "embedding", index: 1, embedding: [1.1, 1.2] },
    ]);
    const qualified = await post(
      { input: "hello again" },
      { "x-openclaw-model": "openai/text-embedding-3-small" },
    );
    expect(qualified.status).toBe(200);
    const qualifiedJson = (await qualified.json()) as { model?: string };
    expect(qualifiedJson.model).toBe("openclaw/default");
    expect(createProvider.mock.lastCall?.[0]).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
    });
    expect(closeProvider).toHaveBeenCalledTimes(3);
  });

  it.each([
    { reports: [USAGE_A, USAGE_B], expected: { prompt_tokens: 7, total_tokens: 9 } },
    { reports: [undefined, USAGE_B], expected: ZERO_USAGE },
    { reports: [USAGE_A, undefined], expected: ZERO_USAGE },
  ])("reports complete usage for split batches: $reports", async ({ reports, expected }) => {
    embedBatch.mockImplementationOnce(async (_inputs, options) => {
      for (const report of reports) {
        options?.onUsage?.(report);
      }
      return [
        [0.1, 0.2],
        [1.1, 1.2],
      ];
    });
    const response = await post({ input: ["a", "b"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ usage: expected });
  });

  it("supports base64 encoding and agent-scoped auth/config resolution", async () => {
    testState.agentsConfig = { entries: { main: {}, beta: {} } };
    resetConfigRuntimeState();
    const res = await post(
      { model: "openclaw/beta", encoding_format: "base64" },
      { "x-openclaw-agent-id": "beta" },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: Array<{ embedding?: string }> };
    expect(typeof json.data?.[0]?.embedding).toBe("string");
    expect(createProvider).toHaveBeenCalled();
    expect(createProvider.mock.lastCall?.[0]).toMatchObject({
      model: expect.any(String),
      agentDir: resolveAgentDir({}, "beta"),
    });
  });

  it.each([
    { enabled: false, dimensions: 8, expected: 8 },
    { enabled: false, dimensions: undefined, expected: undefined },
    { enabled: true, dimensions: undefined, expected: 16 },
  ])(
    "passes dimensions=$dimensions with memory search enabled=$enabled",
    async ({ enabled, dimensions, expected }) => {
      await writeEmbeddingConfig({ memory: { search: { enabled, outputDimensionality: 16 } } });
      await expectDefaultResponse(await post({ dimensions }));
      expect(createProvider.mock.calls.at(-1)?.[0].dimensions).toBe(expected);
    },
  );

  it("rejects explicit unknown agent ids", async () => {
    testState.agentsConfig = { ownership: "explicit", entries: { main: {}, beta: {} } };
    resetConfigRuntimeState();
    const missing = await post({ model: "openclaw" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("has no explicit owner"),
      },
    });
    const header = await post({}, { "x-openclaw-agent-id": "missing-agent" });
    await expectInvalidRequest(header, "Unknown agent 'missing-agent'.");
    const model = await post({ model: "openclaw/missing-agent" });
    await expectInvalidRequest(model, "Unknown agent 'missing-agent'.");
  });

  it.each([
    { name: "unsupported encoding", body: { encoding_format: "hex" }, message: undefined },
    { name: "an empty batch", body: { input: [] }, message: INPUT_ERROR },
    { name: "an empty entry", body: { input: ["valid", ""] }, message: INPUT_ERROR },
    {
      name: "an oversized batch",
      body: { input: Array.from({ length: 129 }, () => "x") },
      message: "Too many inputs (max 128).",
    },
    {
      name: "an invalid agent target",
      body: { model: "ollama/nomic-embed-text" },
      message: "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
    },
  ])("rejects $name before creating a provider", async ({ body, message }) => {
    await expectInvalidRequest(await post(body), message);
    expect(createProvider).not.toHaveBeenCalled();
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
            remote: { baseUrl: genericEmbeddingServer.baseUrl },
          },
        },
      });
      const res = await post(
        { input: ["a", "b"] },
        override ? { "x-openclaw-model": override } : undefined,
      );
      const json = await expectEmbeddingData(res, [
        { object: "embedding", index: 0, embedding: [9.1, 9.2] },
        { object: "embedding", index: 1, embedding: [10.1, 9.2] },
      ]);
      expect(json.usage).toEqual({ prompt_tokens: 777, total_tokens: 778 });
      expect(genericEmbeddingServer.requests.at(-1)?.body).toMatchObject({
        model: override ?? model,
        dimensions: 768,
        input_type: "document",
      });
    },
  );

  it("rejects disallowed x-openclaw-model provider overrides", async () => {
    registerEmbeddingProvider({
      id: "ollama",
      transport: "remote",
      create: async () => ({ provider: null }),
    });
    const res = await post({}, { "x-openclaw-model": "ollama/nomic-embed-text" });
    await expectInvalidRequest(
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
          const proxyPost = (role: "reader" | "writer", override?: string) =>
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
              body: embeddingBody(),
            });
          createProvider.mockClear();
          embedBatch.mockClear();
          const denied = await proxyPost("reader");
          expect({
            status: denied.status,
            providersCreated: createProvider.mock.calls.length,
            embeddingCalls: embedBatch.mock.calls.length,
          }).toEqual({ status: 403, providersCreated: 0, embeddingCalls: 0 });
          expect(await denied.json()).toMatchObject({
            error: { type: "forbidden", message: "missing scope: operator.write" },
          });
          await expectDefaultResponse(await proxyPost("writer"));
          expect(createProvider).toHaveBeenCalledOnce();
          expect(embedBatch).toHaveBeenCalledOnce();
          const override = await proxyPost("writer", "openai/text-embedding-3-small");
          expect(override.status).toBe(403);
          expect(await override.json()).toMatchObject({
            error: { type: "forbidden", message: "missing scope: operator.admin" },
          });
          expect(createProvider).toHaveBeenCalledOnce();
          expect(embedBatch).toHaveBeenCalledOnce();
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

  it.each([
    ["setup", "secret upstream failure", 500, "api_error", "internal error"],
    ["setup", MISSING_KEY, 401, "authentication_error", undefined],
    ["embedding", "503 service unavailable", 503, "api_error", "upstream provider overloaded"],
  ] as const)(
    "maps %s failure (%s) to %s %s",
    async (phase, message, status, type, publicMessage) => {
      const failingOperation = phase === "setup" ? createProvider : embedBatch;
      failingOperation.mockRejectedValueOnce(new Error(message));
      const res = await post();
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: { type, message: publicMessage ?? message } });
    },
  );

  it("redacts credentials in actionable provider errors", async () => {
    const credential = "sk-test-embedding-error-fixture-1234567890";
    embedBatch.mockRejectedValueOnce(new Error(`Incorrect API key provided: ${credential}`));
    const res = await post();
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
      createProvider.mockImplementationOnce(async () => {
        if (phase === "provider acquisition") {
          await waitForPolicyChange();
        }
        return makeProvider({ embedBatch: embed, close });
      });
      const cfg = await captureRuntimeConfigAsyncReader()();
      const pending = post();
      try {
        await operationStarted.promise;
        setRuntimeConfigSnapshot({
          ...cfg,
          gateway: { ...cfg.gateway, allowRealIpFallback: !cfg.gateway?.allowRealIpFallback },
        });
        releaseOperation.resolve();
        const response = await pending;
        if (phase === "provider acquisition") {
          expect(response.status).toBe(401);
          expect(embed).not.toHaveBeenCalled();
        } else {
          await expectDefaultResponse(response);
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
    let receivedSignal: AbortSignal | undefined;
    const embedStarted = createDeferred();
    const releaseEmbed = createDeferred();
    embedBatch.mockImplementationOnce(async (_texts, options) => {
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
    const { request: clientRequest, body } = rawEmbeddingRequest("hello");
    clientRequest.on("error", () => {});
    clientRequest.end(body);
    await embedStarted.promise;
    clientRequest.destroy();
    try {
      await vi.waitFor(() => expect(receivedSignal).toMatchObject({ aborted: true }));
    } finally {
      releaseEmbed.resolve();
    }
    await vi.waitFor(() => expect(closeProvider).toHaveBeenCalledTimes(1));
  });

  it("blocks a failed cleanup scope until restart without blocking other agents", async () => {
    Reflect.set(openAiAdapter, "transport", "local");
    testState.agentsConfig = { entries: { main: {}, "cleanup-failure": {} } };
    resetConfigRuntimeState();
    closeProvider.mockRejectedValueOnce(new Error("close failed"));
    const first = await post({ model: "openclaw/cleanup-failure", input: "first" });
    expect(first.status).toBe(200);
    for (const input of ["blocked", "still blocked"]) {
      const blocked = await post({ model: "openclaw/cleanup-failure", input });
      expect(blocked.status).toBe(500);
    }
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(closeProvider).toHaveBeenCalledTimes(1);
    await expectDefaultResponse(await post({ model: "openclaw/main", input: "unaffected" }));
  });

  it.each([
    { kind: "local provider", localProvider: false, modelOverride: false },
    { kind: "created local provider", localProvider: true, modelOverride: false },
    { kind: "model override", localProvider: false, modelOverride: true },
  ])("does not bypass pending cleanup with $kind", async ({ localProvider, modelOverride }) => {
    await using cleanup = await pendingCleanup(localProvider);
    if (localProvider) {
      registerEmbeddingProvider({ ...openAiAdapter, id: "local", transport: "local" });
      createProvider.mockResolvedValueOnce(makeProvider({ id: "local", model: "local-embed" }));
    }
    // Concurrent provider admission needs distinct connections; each socket owns serial requests.
    const firstPromise = post(
      { input: "first" },
      {
        connection: "close",
        ...(modelOverride ? { "x-openclaw-model": "openai/model-a" } : {}),
      },
    );
    cleanup.requests.push(firstPromise);
    await waitForProviderEntry(cleanup.started, firstPromise);
    expect(closeProvider).toHaveBeenCalledTimes(1);
    const secondEntered = cleanup.watchAdmission();
    const secondPromise = post(
      { input: "second" },
      {
        connection: "close",
        ...(modelOverride ? { "x-openclaw-model": "openai/model-b" } : {}),
      },
    );
    cleanup.requests.push(secondPromise);
    await waitForProviderEntry(secondEntered, secondPromise);
    expect(createProvider).toHaveBeenCalledTimes(1);
    const shutdown = drainRetainedOpenAiEmbeddingProviders().then(() => {
      expect(cleanup.finished()).toBe(true);
    });
    cleanup.release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    await shutdown;
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(createProvider).toHaveBeenCalledTimes(2);
  });

  it("does not create a provider for a disconnected request waiting behind cleanup", async () => {
    await using cleanup = await pendingCleanup();
    const firstPromise = post({ input: "first" });
    cleanup.requests.push(firstPromise);
    let secondRequest: ReturnType<typeof httpRequest> | undefined;
    try {
      await waitForProviderEntry(cleanup.started, firstPromise);
      expect(closeProvider).toHaveBeenCalledTimes(1);
      const queued = cleanup.watchAdmission();
      const { request, body } = rawEmbeddingRequest("second");
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
      const signal = await Promise.race([queued, unexpectedResponse]);
      const aborted = createDeferred();
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      secondRequest.destroy();
      await aborted.promise;
      await secondRequestClosed.promise;
      cleanup.release();
      expect((await firstPromise).status).toBe(200);
      const next = await post({ input: "next" });
      expect(next.status).toBe(200);
      expect(createProvider).toHaveBeenCalledTimes(2);
    } finally {
      cleanup.release();
      secondRequest?.destroy();
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
    createProvider
      .mockResolvedValueOnce(makeProvider({ embedBatch: firstEmbed, close: vi.fn(async () => {}) }))
      .mockResolvedValueOnce(
        makeProvider({ embedBatch: secondEmbed, close: vi.fn(async () => {}) }),
      );
    const firstPromise = post({ input: "first" });
    const requests = [firstPromise];
    try {
      await waitForProviderEntry(firstEmbedStarted.promise, firstPromise);
      expect(firstEmbed).toHaveBeenCalledTimes(1);
      const secondPromise = post({ input: "second" });
      requests.push(secondPromise);
      const second = await secondPromise;
      expect(second.status).toBe(200);
      expect(secondEmbed).toHaveBeenCalledTimes(1);
      releaseFirstEmbed();
      expect((await firstPromise).status).toBe(200);
    } finally {
      releaseFirstEmbed();
      await Promise.allSettled(requests);
      createProvider.mockReset();
    }
  });
});
