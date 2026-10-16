import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { getSessionMcpRequestSignal } from "../agents/agent-bundle-mcp-request-context.js";
import * as minimaxVlm from "../agents/minimax-vlm.js";
import * as modelAuth from "../agents/model-auth.js";
import { acquireReadOnlyPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import { closeEphemeralPreparedModelRuntimeResources } from "../agents/prepared-model-runtime.resources.js";
import * as providerStream from "../agents/provider-stream.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerContextEngineInRegistry } from "../context-engine/registry.js";
import { getModelLlmRuntime } from "../llm/model-runtime-binding.js";
import * as llmStream from "../llm/stream.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { acquirePluginRegistryForInspection, loadPluginRegistryHandle } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../plugins/runtime/generation-scope.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { describeImagesWithModelCore, describeImageWithModelCore } from "./image.js";

function createNativeImageFixture(
  reject = false,
  modelRef: { provider: string; model: string; input?: Array<"text" | "image"> } = {
    provider: "image-description-native",
    model: "image-model",
  },
) {
  const dir = makePluginLoaderTempDir();
  const id = modelRef.provider;
  const stateKey = `__image_description_${path.basename(dir)}`;
  const connections: Array<{
    database: DatabaseSync;
    dbPath: string;
    registry: PluginRegistry;
    disposals: number;
    lateReads: number;
    cleanupReads: number;
  }> = [];
  const cancellation: {
    signal?: AbortSignal;
    cleanupSignal?: AbortSignal;
    registry?: PluginRegistry;
    afterRegistry?: PluginRegistry;
    failure?: unknown;
  } = {};
  const state = {
    connections,
    started: createDeferredCore(),
    finish: createDeferredCore(),
    settled: createDeferredCore(),
    setupStarted: createDeferredCore(),
    resumeSetup: createDeferredCore(),
    holdSetup: false,
    holdSetupTail: false,
    rejectSetup: false,
    finishSetupTail: createDeferredCore(),
    setupTailSettled: createDeferredCore(),
    setupTailReads: 0,
    reasoningOnly: false,
    calls: 0,
    setupReads: 0,
    watchCancellation: false,
    holdWork: false,
    cancellation,
    cleanupStarted: createDeferredCore(),
    finishCleanup: createDeferredCore(),
    finishWork: createDeferredCore(),
    workSettled: createDeferredCore(),
    trackWork: trackAsyncWork,
    readSignal: getSessionMcpRequestSignal,
    readGeneration: getPluginRuntimeGenerationRegistry,
    createStream: createAssistantMessageEventStream,
    readRegistry: getPluginRegistryForContext,
    databasePath: () => path.join(dir, `provider-${connections.length}.sqlite`),
  };
  Object.defineProperty(globalThis, stateKey, { configurable: true, value: state });
  const plugin = writePlugin({
    dir,
    id,
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  const state = globalThis[${JSON.stringify(stateKey)}];
  const dbPath = state.databasePath();
  const database = new DatabaseSync(dbPath);
  database.exec("CREATE TABLE proof (value INTEGER); INSERT INTO proof VALUES (42)");
  const connection = { database, dbPath, registry: state.readRegistry(), disposals: 0, lateReads: 0, cleanupReads: 0 };
  state.connections.push(connection);
  const read = () => database.prepare("SELECT value FROM proof").get().value;
  const trackRead = (finish, settled, afterRead = () => {}) => {
    void state.trackWork(async () => { await finish.promise; read(); afterRead(); })
      .then(() => settled.resolve(), (error) => {
        state.cancellation.failure = error;
        settled.resolve();
      });
  };
  api.lifecycle.registerRuntimeLifecycle({ id: "native-image", dispose() {
    connection.disposals++;
    database.close();
  }});
  api.registerProvider({
    id: ${JSON.stringify(id)}, label: "Native image", auth: [],
    async prepareRuntimeAuth() {
      if (state.holdSetupTail) {
        trackRead(state.finishSetupTail, state.setupTailSettled, () => { state.setupTailReads++; });
      }
      if (state.holdSetup) {
        read();
        state.setupStarted.resolve();
        await state.resumeSetup.promise;
        read();
        state.setupReads++;
      }
      if (state.rejectSetup) throw new Error("synthetic setup failure");
    },
    createStreamFn() {
      return async (model) => {
        read();
        if (state.watchCancellation) {
          const signal = state.cancellation.signal = state.readSignal();
          const cancel = () => {
            state.cancellation.cleanupSignal = state.readSignal();
            state.cancellation.registry = state.readGeneration();
            void state.trackWork(async () => {
              state.cleanupStarted.resolve();
              await state.finishCleanup.promise;
              read();
              connection.cleanupReads++;
              state.cancellation.afterRegistry = state.readGeneration();
            }).catch((error) => { state.cancellation.failure = error; });
          };
          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) cancel();
        }
        if (state.holdWork) {
          trackRead(state.finishWork, state.workSettled);
        }
        state.calls++;
        state.started.resolve();
        try {
          await state.finish.promise;
          const value = read();
          connection.lateReads++;
          if (${reject}) throw new Error("synthetic late image failure");
          const stream = state.createStream();
          stream.push({ type: "done", reason: "stop", message: {
            role: "assistant", content: state.reasoningOnly
              ? [{ type: "thinking", thinking: "synthetic reasoning", thinkingSignature: "reasoning_content" }]
              : [{ type: "text", text: "native image " + value }],
            api: model.api, provider: model.provider, model: model.id,
            stopReason: "stop", timestamp: 0,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
          }});
          stream.end();
          return stream;
        } finally { state.settled.resolve(); }
      };
    },
  });
}};`,
  });
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      providers: [id],
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  );
  const config: OpenClawConfig = {
    models: {
      providers: {
        [id]: {
          api: "openai-responses",
          baseUrl: "https://image-fixture.invalid/v1",
          apiKey: "synthetic-fixture",
          models: [
            {
              id: modelRef.model,
              name: "Image model",
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              input: modelRef.input ?? ["text", "image"],
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        },
      },
    },
    plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
  };
  const agentDir = path.join(dir, "agent");
  const resume = () => {
    for (const gate of [
      state.finish,
      state.resumeSetup,
      state.finishCleanup,
      state.finishWork,
      state.finishSetupTail,
    ]) {
      gate.resolve();
    }
  };
  return {
    dir,
    id,
    config,
    agentDir,
    state,
    resume,
    request: {
      cfg: config,
      agentDir,
      workspaceDir: dir,
      provider: id,
      model: modelRef.model,
      buffer: Buffer.from("synthetic image"),
      mime: "image/png",
      fileName: "image.png",
      timeoutMs: 1000,
    },
    cleanup() {
      resume();
      for (const connection of connections) {
        if (connection.database.isOpen) {
          connection.database.close();
        }
      }
      Reflect.deleteProperty(globalThis, stateKey);
    },
  };
}

type NativeFixture = ReturnType<typeof createNativeImageFixture>;
function nativeWork(fixture: NativeFixture) {
  const parent = new AsyncWorkScope();
  let lease: Awaited<ReturnType<typeof acquireFixtureRuntime>> | undefined;
  let pending: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  return {
    parent,
    async acquire() {
      return (lease = await acquireFixtureRuntime(fixture));
    },
    start(task: () => Promise<unknown>, tracked = true) {
      return (pending = (tracked ? parent.track(task) : task()).catch((error: unknown) => error));
    },
    async retire() {
      await lease?.[Symbol.asyncDispose]();
      closing ??= closePreparedModelRuntimeSnapshots();
    },
    async drain() {
      await parent.drain();
      await closing;
    },
    async cleanup() {
      fixture.resume();
      await pending;
      await parent.drain();
      await lease?.[Symbol.asyncDispose]();
      await closing;
      await closePreparedModelRuntimeSnapshots();
    },
  };
}
const nativeCleanups: Array<() => Promise<void>> = [];
function nativeImageFixture(...args: Parameters<typeof createNativeImageFixture>) {
  const fixture = createNativeImageFixture(...args);
  const work = nativeWork(fixture);
  vi.stubEnv("OPENCLAW_HOME", fixture.dir);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixture.dir, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(fixture.dir, "config.json"));
  useNoBundledPlugins();
  nativeCleanups.push(async () => {
    try {
      await work.cleanup();
    } finally {
      fixture.cleanup();
    }
  });
  return { fixture, work, state: fixture.state };
}
function describeFixture(
  fixture: NativeFixture,
  lease: Awaited<ReturnType<typeof acquireFixtureRuntime>>,
  overrides: Partial<Parameters<typeof describeImageWithModelCore>[0]> = {},
) {
  return describeImageWithModelCore({
    ...fixture.request,
    preparedModelRuntime: lease.snapshot,
    ...overrides,
  });
}
async function awaitEntered(entered: Promise<void>, outcome: Promise<unknown>) {
  await Promise.race([
    entered,
    outcome.then(() => {
      throw new Error("Image request settled before reaching its held boundary");
    }),
  ]);
}
function expectClosed(connection: NativeFixture["state"]["connections"][number]) {
  expect(connection).toMatchObject({ disposals: 1, database: { isOpen: false } });
}
function expectPersisted(connection: NativeFixture["state"]["connections"][number]) {
  using reopened = new DatabaseSync(connection.dbPath, { readOnly: true });
  expect(reopened.prepare("SELECT value FROM proof").get()?.value).toBe(42);
}

function acquireFixtureRuntime(fixture: NativeFixture) {
  return acquireReadOnlyPreparedModelRuntime(
    {
      config: fixture.config,
      agentId: "main",
      agentDir: fixture.agentDir,
      workspaceDir: fixture.dir,
      loadRuntimePlugins: true,
      skipCredentials: true,
      runtimePluginSelections: [{ provider: fixture.id, modelId: fixture.request.model }],
    },
    { catalogMode: "static" },
  );
}

afterEach(async () => {
  try {
    for (const cleanup of nativeCleanups.splice(0)) {
      await cleanup();
    }
  } finally {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    try {
      await closePreparedModelRuntimeSnapshots();
    } finally {
      resetPluginLoaderTestStateForTest();
    }
  }
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("does not dispatch an image completion retired during transport initialization", async () => {
  const { work, state, fixture } = nativeImageFixture();
  const lease = await work.acquire();
  vi.useFakeTimers();
  const dispatch = vi.fn(() => {
    throw new Error("Unexpected retired image provider dispatch");
  });
  const register = vi
    .spyOn(providerStream, "registerProviderStreamForModel")
    .mockImplementationOnce(({ model }) => {
      const runtime = getModelLlmRuntime(model);
      expect(runtime).toBeDefined();
      runtime?.registry.registerApiProvider({
        api: model.api,
        stream: dispatch,
        streamSimple: dispatch,
      });
      return undefined;
    });
  const complete = llmStream.complete;
  let retirement: Promise<void> | undefined;
  const facade = vi.spyOn(llmStream, "complete").mockImplementationOnce((...args) => {
    const completion = complete(...args);
    retirement = closeEphemeralPreparedModelRuntimeResources();
    expect(args[2]?.signal?.aborted).toBe(false);
    return completion;
  });
  try {
    await expect(describeFixture(fixture, lease)).rejects.toThrow(
      "Prepared plugin registry resources have been released",
    );
    expect(facade).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    facade.mockRestore();
    register.mockRestore();
    await lease[Symbol.asyncDispose]();
    await retirement;
  }
  expectClosed(state.connections[0]!);
});

it.each(["timeout", "cancellation", "late-rejection"] as const)(
  "retains the supplied generation and adopted donor after %s reports",
  async (mode) => {
    const { work, state, fixture } = nativeImageFixture(mode === "late-rejection");
    const donor = await acquirePluginRegistryForInspection({ config: fixture.config });
    const abort = new AbortController();
    try {
      expect(
        registerContextEngineInRegistry(
          donor.registry,
          fixture.id,
          () => ({
            info: { id: fixture.id, name: "Native donor" },
            ingest: async () => ({ ingested: false }),
            assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
            compact: async () => ({ ok: true, compacted: false }),
          }),
          `plugin:${fixture.id}`,
          { lifecycle: "runtime" },
        ),
      ).toEqual({ ok: true });
      setActivePluginRegistry(donor.registry);
      const acquired = await work.acquire();
      expect(state.connections).toHaveLength(2);
      const [donorConnection, primary] = state.connections;
      expect(acquired.snapshot.pluginRegistry).not.toBe(primary!.registry);
      expect(acquired.snapshot.pluginRegistry?.contextEngines.get(fixture.id)).toBe(
        donor.registry.contextEngines.get(fixture.id),
      );
      vi.useFakeTimers();
      const outcome = work.start(() =>
        describeFixture(fixture, acquired, { timeoutMs: 25, signal: abort.signal }),
      );
      await awaitEntered(state.started.promise, outcome);
      if (mode === "timeout") {
        await vi.advanceTimersByTimeAsync(25);
      } else {
        abort.abort(new Error("synthetic image cancellation"));
      }
      expect(await outcome).toMatchObject({
        message:
          mode === "timeout"
            ? expect.stringContaining("image description request timed out")
            : "synthetic image cancellation",
      });
      await acquired[Symbol.asyncDispose]();
      await donor.release();
      await work.retire();
      await vi.advanceTimersByTimeAsync(0);
      for (const connection of [primary, donorConnection]) {
        expect(connection).toMatchObject({ database: { isOpen: true }, disposals: 0 });
      }
      await expect(describeFixture(fixture, acquired)).rejects.toThrow(
        /resources have been released/,
      );
      state.finish.resolve();
      await state.settled.promise;
      await work.drain();
      expect(primary!.lateReads).toBe(1);
      for (const connection of state.connections) {
        expectClosed(connection);
        expectPersisted(connection);
      }
    } finally {
      abort.abort();
      await donor.release();
    }
  },
);

it.each([false, true])(
  "leaves the supplying registry with its caller (raw: %s)",
  async (rawRegistry) => {
    const { work, state, fixture } = nativeImageFixture();
    const raw = rawRegistry ? loadPluginRegistryHandle({ config: fixture.config }) : undefined;
    if (raw) {
      setActivePluginRegistry(raw);
    }
    const lease = await work.acquire();
    state.finish.resolve();
    expect(
      await describeFixture(
        fixture,
        lease,
        raw
          ? {
              preparedModelRuntime: { ...lease.snapshot, pluginRegistry: raw },
            }
          : {},
      ),
    ).toMatchObject({ text: "native image 42" });
    expect(state.connections[0]).toMatchObject({ disposals: 0, database: { isOpen: true } });
    await work.retire();
    await work.drain();
    if (!rawRegistry) {
      expect(state.connections[0]!.disposals).toBe(1);
    }
  },
);

it.each(["setup", "retry"] as const)(
  "refuses new provider work after process close during %s",
  async (phase) => {
    const { work, state, fixture } = nativeImageFixture();
    const lease = await work.acquire();
    state.holdSetup = phase === "setup";
    state.reasoningOnly = phase === "retry";
    const outcome = work.start(() => describeFixture(fixture, lease), false);
    const entered = phase === "setup" ? state.setupStarted : state.started;
    await awaitEntered(entered.promise, outcome);
    await work.retire();
    expect(state.connections[0]!.database.isOpen).toBe(true);
    state.resumeSetup.resolve();
    state.finish.resolve();
    expect(await outcome).toMatchObject({
      message: "Prepared plugin registry resources have been released",
    });
    await work.drain();
    expect(state).toMatchObject({
      calls: phase === "setup" ? 0 : 1,
      setupReads: phase === "setup" ? 1 : 0,
      connections: [{ lateReads: phase === "setup" ? 0 : 1, disposals: 1 }],
    });
  },
);

it.each(["parent", "normal", "admitted-tail"] as const)(
  "preserves MCP cancellation and cleanup context during %s closure",
  async (mode) => {
    const { work, state, fixture } = nativeImageFixture();
    const lease = await work.acquire();
    state.watchCancellation = true;
    state.holdWork = mode === "admitted-tail";
    const result = work.start(() =>
      withPluginRuntimeGenerationScope(lease.snapshot, () => describeFixture(fixture, lease)),
    );
    await awaitEntered(state.started.promise, result);
    if (mode === "parent") {
      const reason = new Error("synthetic parent close");
      withPluginRuntimeGenerationScope(
        {
          metadataSnapshot: lease.snapshot.metadataSnapshot,
          pluginRegistry: createEmptyPluginRegistry(),
        },
        () => work.parent.beginClose(reason),
      );
      expect(state.cancellation.signal?.aborted).toBe(true);
      expect(state.cancellation.signal?.reason).toBe(reason);
    } else {
      state.finish.resolve();
      expect(await result).toMatchObject({ text: "native image 42" });
      if (mode === "admitted-tail") {
        expect(state.cancellation.signal?.aborted).toBe(false);
        state.finishWork.resolve();
        await state.workSettled.promise;
      }
    }
    await state.cleanupStarted.promise;
    expect(state.cancellation.cleanupSignal?.aborted).toBe(true);
    expect(state.cancellation.cleanupSignal?.reason).toBe(state.cancellation.signal?.reason);
    expect(state.cancellation.registry).toBe(lease.snapshot.pluginRegistry);
    await work.retire();
    expect(state.connections[0]!.database.isOpen).toBe(true);
    state.finish.resolve();
    expect(await result).toMatchObject({ text: "native image 42" });
    state.finishCleanup.resolve();
    await work.drain();
    expect(state.cancellation.failure).toBeUndefined();
    expect(state.cancellation.afterRegistry).toBe(lease.snapshot.pluginRegistry);
    expect(state.connections[0]).toMatchObject({ cleanupReads: 1, disposals: 1 });
  },
);

it.each(["success", "failure", "timeout"] as const)(
  "retains native resources through auth descendants after setup %s",
  async (mode) => {
    const { work, state, fixture } = nativeImageFixture();
    const lease = await work.acquire();
    state.holdSetup = true;
    state.holdSetupTail = true;
    state.rejectSetup = mode === "failure";
    state.finish.resolve();
    vi.useFakeTimers();
    const outcome = work.start(() => describeFixture(fixture, lease, { timeoutMs: 25 }));
    await awaitEntered(state.setupStarted.promise, outcome);
    if (mode === "timeout") {
      await vi.advanceTimersByTimeAsync(25);
      expect(await outcome).toMatchObject({
        message: expect.stringContaining("image description setup timed out"),
      });
    }
    state.resumeSetup.resolve();
    const result = await outcome;
    if (mode === "success") {
      expect(result).toMatchObject({ text: "native image 42" });
    } else if (mode === "failure") {
      expect(result).toMatchObject({ message: "synthetic setup failure" });
    }
    // Let the auth callback return after its deadline while its descendant is still held.
    await vi.advanceTimersByTimeAsync(0);
    expect(state).toMatchObject({ setupReads: 1, calls: mode === "success" ? 1 : 0 });
    await work.retire();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.connections[0]!.database.isOpen).toBe(true);
    state.finishSetupTail.resolve();
    await state.setupTailSettled.promise;
    await work.drain();
    expect(state.cancellation.failure).toBeUndefined();
    expect(state.setupTailReads).toBe(1);
    expect(state.connections[0]!.disposals).toBe(1);
    expectPersisted(state.connections[0]!);
  },
);

it.each(["open", "resolved", "fallback"] as const)(
  "fences MiniMax image admission while the managed owner is %s",
  async (mode) => {
    const { work, state, fixture } = nativeImageFixture(false, {
      provider: "minimax",
      model: "MiniMax-VL-01",
      input: mode === "fallback" ? ["text"] : ["text", "image"],
    });
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const lease = await work.acquire();
    const read = () =>
      state.connections[0]!.database.prepare("SELECT value FROM proof").get()?.value;
    const request = vi.spyOn(minimaxVlm, "minimaxUnderstandImage").mockImplementation(async () => {
      expect(read()).toBe(42);
      if (mode === "resolved") {
        entered.resolve();
        await resume.promise;
        expect(read()).toBe(42);
      }
      return "native MiniMax image";
    });
    const originalAuth = modelAuth.resolveApiKeyForProviderCore;
    const auth =
      mode === "fallback"
        ? vi
            .spyOn(modelAuth, "resolveApiKeyForProviderCore")
            .mockImplementation(async (...args) => {
              entered.resolve();
              await resume.promise;
              return await originalAuth(...args);
            })
        : undefined;
    let outcome: Promise<unknown> | undefined;
    try {
      outcome = work.start(() =>
        describeImagesWithModelCore({
          ...fixture.request,
          preparedModelRuntime: lease.snapshot,
          images: [fixture.request, fixture.request],
        }),
      );
      if (mode !== "open") {
        await awaitEntered(entered.promise, outcome);
        await work.retire();
        expect(read()).toBe(42);
        resume.resolve();
        expect(await outcome).toMatchObject({
          message: "Prepared plugin registry resources have been released",
        });
      } else {
        expect(await outcome).toMatchObject({
          text: "Image 1:\nnative MiniMax image\n\nImage 2:\nnative MiniMax image",
        });
      }
      expect(request).toHaveBeenCalledTimes(mode === "open" ? 2 : mode === "resolved" ? 1 : 0);
      await work.retire();
      await work.drain();
      expect(state.connections[0]!.disposals).toBe(1);
      expectPersisted(state.connections[0]!);
    } finally {
      resume.resolve();
      await outcome;
      await work.drain();
      request.mockRestore();
      auth?.mockRestore();
    }
  },
);
