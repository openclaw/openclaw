import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, expect, it, vi, type MockInstance } from "vitest";
import { getSessionMcpRequestSignal } from "../agents/agent-bundle-mcp-request-context.js";
import { requireApiKey } from "../agents/model-auth.js";
import * as preparedRuntime from "../agents/prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModel,
} from "../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Context, Model, ProviderStreamOptions } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { summarizeText } from "../plugin-sdk/speech-core.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../plugins/runtime/generation-scope.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTtsConfig } from "./tts-settings.js";

type SummaryConnection = {
  database: DatabaseSync;
  dbPath: string;
  disposals: number;
  completionReads: number;
  openAtCompletion?: boolean;
  cleanupReads: number;
  setupReads: number;
};

function nativeSummaryFixture() {
  const dir = makePluginLoaderTempDir();
  const id = "summary-resource-fixture";
  const key = `__summary_resources_${path.basename(dir)}`;
  const connections: SummaryConnection[] = [];
  const cancellation: {
    signal?: AbortSignal;
    requestSignal?: AbortSignal;
    cleanupSignal?: AbortSignal;
    registry?: PluginRegistry;
    afterRegistry?: PluginRegistry;
    failure?: unknown;
  } = {};
  const calls: Array<{ model: string; context: Context }> = [];
  const state = {
    connections,
    setupStarted: createDeferredCore(),
    finishSetup: createDeferredCore(),
    finishSetupTail: createDeferredCore(),
    started: createDeferredCore(),
    finish: createDeferredCore(),
    finishTail: createDeferredCore(),
    cleanupStarted: createDeferredCore(),
    finishCleanup: createDeferredCore(),
    holdSetup: false,
    rejectSetup: false,
    setupTail: false,
    completionTail: false,
    watchCleanup: false,
    calls,
    cancellation,
    async prepare(connection: SummaryConnection, read: () => number) {
      if (state.holdSetup) {
        state.setupStarted.resolve();
        await state.finishSetup.promise;
        read();
      }
      if (state.setupTail) {
        void trackAsyncWork(async () => {
          await state.finishSetupTail.promise;
          read();
          connection.setupReads++;
        }).catch((error: unknown) => {
          cancellation.failure = error;
        });
      }
      if (state.rejectSetup) {
        throw new Error("synthetic summary setup failure");
      }
    },
    async stream(
      model: Model,
      context: Context,
      options: ProviderStreamOptions,
      connection: SummaryConnection,
      read: () => number,
    ) {
      connection.openAtCompletion = connection.database.isOpen;
      read();
      state.calls.push({ model: model.id, context });
      cancellation.requestSignal = options.signal;
      if (state.completionTail) {
        void trackAsyncWork(async () => {
          await state.finishTail.promise;
          read();
          connection.cleanupReads++;
        }).catch((error: unknown) => {
          cancellation.failure = error;
        });
      }
      if (state.watchCleanup) {
        const signal = (cancellation.signal = getSessionMcpRequestSignal());
        const cleanup = () => {
          cancellation.cleanupSignal = getSessionMcpRequestSignal();
          cancellation.registry = getPluginRuntimeGenerationRegistry();
          void trackAsyncWork(async () => {
            state.cleanupStarted.resolve();
            await state.finishCleanup.promise;
            read();
            connection.cleanupReads++;
            cancellation.afterRegistry = getPluginRuntimeGenerationRegistry();
          }).catch((error: unknown) => {
            cancellation.failure = error;
          });
        };
        signal?.addEventListener("abort", cleanup, { once: true });
        if (signal?.aborted) {
          cleanup();
        }
      }
      state.started.resolve();
      await state.finish.promise;
      const value = read();
      connection.completionReads++;
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `<think>Private reasoning</think>Spoken summary ${value}.` },
          ],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "stop",
          timestamp: 0,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
      stream.end();
      return stream;
    },
    dbPath: () => path.join(dir, `source-${connections.length}.sqlite`),
  };
  Object.defineProperty(globalThis, key, { configurable: true, value: state });
  const plugin = writePlugin({
    dir,
    id,
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  const state = globalThis[${JSON.stringify(key)}];
  const dbPath = state.dbPath();
  const database = new DatabaseSync(dbPath);
  database.exec("CREATE TABLE proof (value INTEGER); INSERT INTO proof VALUES (42)");
  const connection = { database, dbPath, disposals: 0, completionReads: 0, cleanupReads: 0, setupReads: 0 };
  state.connections.push(connection);
  const read = () => database.prepare("SELECT value FROM proof").get().value;
  api.lifecycle.registerRuntimeLifecycle({ id: "summary-db", dispose() { connection.disposals++; database.close(); } });
  api.registerProvider({ id: ${JSON.stringify(id)}, label: "Summary fixture", auth: [],
    prepareRuntimeAuth() { return state.prepare(connection, read); },
    createStreamFn() { return (model, context, options) => state.stream(model, context, options, connection, read); }
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
    agents: {
      entries: { main: {} },
      defaults: { workspace: dir, model: { primary: `${id}/default-model` } },
    },
    tts: { summaryModel: `${id}/summary-model` },
    models: {
      providers: {
        [id]: {
          api: "openai-completions",
          baseUrl: "https://summary-fixture.invalid/v1",
          apiKey: "synthetic-fixture",
          models: ["default-model", "summary-model"].map((model) => ({
            id: model,
            name: model,
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            input: ["text"],
            contextWindow: 8192,
            maxTokens: 1024,
          })),
        },
      },
    },
    plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
  };
  const agentDir = path.join(dir, "agent");
  const parent = new AsyncWorkScope();
  const outcomes: Promise<unknown>[] = [];
  let lease: Awaited<ReturnType<typeof preparedRuntime.acquireReadOnlyPreparedModelRuntime>>;
  let acquire: MockInstance<typeof preparedRuntime.acquireAgentRunPreparedModelRuntime>;
  return {
    config,
    state,
    parent,
    get lease() {
      return lease;
    },
    get acquire() {
      return acquire;
    },
    async run(test: () => Promise<void>) {
      try {
        await withEnvAsync(
          {
            OPENCLAW_HOME: dir,
            OPENCLAW_STATE_DIR: path.join(dir, "state"),
            OPENCLAW_CONFIG_PATH: path.join(dir, "config.json"),
          },
          async () => {
            useNoBundledPlugins();
            lease = await preparedRuntime.acquireReadOnlyPreparedModelRuntime(
              {
                config,
                agentId: "main",
                agentDir,
                workspaceDir: dir,
                loadRuntimePlugins: true,
                skipCredentials: true,
                runtimePluginSelections: [{ provider: id, modelId: "summary-model" }],
              },
              undefined,
              "static",
            );
            acquire = vi
              .spyOn(preparedRuntime, "acquireAgentRunPreparedModelRuntime")
              .mockResolvedValue(lease);
            try {
              await test();
            } finally {
              state.finishSetup.resolve();
              state.finishSetupTail.resolve();
              state.finish.resolve();
              state.finishTail.resolve();
              state.finishCleanup.resolve();
              await Promise.all(outcomes);
              await parent.drain();
              lease.release();
              await closePreparedModelRuntimeSnapshots();
            }
          },
        );
      } finally {
        for (const connection of connections) {
          if (connection.database.isOpen) {
            connection.database.close();
          }
        }
        Reflect.deleteProperty(globalThis, key);
      }
    },
    summarize(timeoutMs = 1000, deps?: Parameters<typeof summarizeText>[1]) {
      const outcome = parent
        .track(() =>
          withPluginRuntimeGenerationScope(lease.snapshot, () =>
            summarizeText(
              {
                text: "The original visible reply remains intact. ".repeat(30),
                targetLength: 120,
                cfg: config,
                config: resolveTtsConfig(config),
                timeoutMs,
              },
              deps,
            ),
          ),
        )
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      outcomes.push(outcome);
      return outcome;
    },
    async assertClosed() {
      await parent.drain();
      await closePreparedModelRuntimeSnapshots();
      for (const source of connections) {
        expect(source.disposals).toBe(1);
        expect(source.database.isOpen).toBe(false);
        const reopened = new DatabaseSync(source.dbPath, { readOnly: true });
        try {
          expect(reopened.prepare("SELECT value FROM proof").get()?.value).toBe(42);
        } finally {
          reopened.close();
        }
      }
    },
  };
}

async function entered(phase: Promise<void>, outcome: Promise<unknown>) {
  await Promise.race([
    phase,
    outcome.then((value) => {
      throw new Error(`Summary settled before its held phase: ${JSON.stringify(value)}`);
    }),
  ]);
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closePreparedModelRuntimeSnapshots();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it.each([false, true])(
  "owns the selected summary model through completion and cleanup (tail=%s)",
  async (tail) => {
    const fixture = nativeSummaryFixture();
    await fixture.run(async () => {
      fixture.state.completionTail = tail;
      fixture.state.finish.resolve();
      const outcome = await fixture.summarize();
      expect(fixture.state.connections[0]?.openAtCompletion).toBe(true);
      expect(outcome).toMatchObject({
        result: { summary: "Spoken summary 42." },
      });
      expect(fixture.state.calls.map((call) => call.model)).toEqual(["summary-model"]);
      if (tail) {
        await setImmediate();
        expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
        fixture.state.finishTail.resolve();
      }
      await fixture.assertClosed();
      expect(fixture.state.connections[0]?.completionReads).toBe(1);
      expect(fixture.state.connections[0]?.cleanupReads).toBe(tail ? 1 : 0);
      expect(fixture.state.cancellation.failure).toBeUndefined();
    });
  },
);

it("starts the summary deadline after preparation and keeps an uncooperative provider owned", async () => {
  const fixture = nativeSummaryFixture();
  await fixture.run(async () => {
    vi.useFakeTimers();
    fixture.state.holdSetup = true;
    const outcome = fixture.summarize(25);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await entered(fixture.state.setupStarted.promise, outcome);
    await vi.advanceTimersByTimeAsync(100);
    expect(fixture.state.calls).toHaveLength(0);
    expect(settled).toBe(false);
    fixture.state.finishSetup.resolve();
    await entered(fixture.state.started.promise, outcome);
    expect(fixture.state.cancellation.requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    expect(fixture.state.cancellation.requestSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
    fixture.state.finish.resolve();
    expect(await outcome).toMatchObject({ result: { summary: "Spoken summary 42." } });
    await fixture.assertClosed();
  });
});

it.each(["normal", "parent"] as const)(
  "drains summary cancellation work in the captured %s context",
  async (mode) => {
    const fixture = nativeSummaryFixture();
    await fixture.run(async () => {
      fixture.state.watchCleanup = true;
      const outcome = fixture.summarize();
      await entered(fixture.state.started.promise, outcome);
      if (mode === "parent") {
        const reason = new Error("synthetic parent shutdown");
        withPluginRuntimeGenerationScope(
          {
            metadataSnapshot: fixture.lease.snapshot.metadataSnapshot,
            pluginRegistry: createEmptyPluginRegistry(),
          },
          () => fixture.parent.beginClose(reason),
        );
        expect(fixture.state.cancellation.signal?.reason).toBe(reason);
      }
      fixture.state.finish.resolve();
      expect(await outcome).toMatchObject({ result: { summary: "Spoken summary 42." } });
      await setImmediate();
      expect(fixture.state.cancellation.signal?.aborted).toBe(true);
      await fixture.state.cleanupStarted.promise;
      expect(fixture.state.cancellation.cleanupSignal?.aborted).toBe(true);
      expect(fixture.state.cancellation.registry).toBe(fixture.lease.snapshot.pluginRegistry);
      expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
      fixture.state.finishCleanup.resolve();
      await fixture.assertClosed();
      expect(fixture.state.cancellation.afterRegistry).toBe(fixture.lease.snapshot.pluginRegistry);
      expect(fixture.state.cancellation.failure).toBeUndefined();
      expect(fixture.state.connections[0]?.cleanupReads).toBe(1);
    });
  },
);

it("owns a failed summary preparation until its auth descendant settles", async () => {
  const fixture = nativeSummaryFixture();
  await fixture.run(async () => {
    fixture.state.setupTail = true;
    fixture.state.rejectSetup = true;
    expect(await fixture.summarize()).toMatchObject({
      error: expect.objectContaining({ message: "synthetic summary setup failure" }),
    });
    await setImmediate();
    expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
    expect(fixture.state.calls).toHaveLength(0);
    fixture.state.finishSetupTail.resolve();
    await fixture.assertClosed();
    expect(fixture.state.connections[0]?.setupReads).toBe(1);
    expect(fixture.state.cancellation.failure).toBeUndefined();
  });
});

it.each(["success", "auth-abort", "completion-abort"] as const)(
  "keeps injected model ownership and error classification for %s",
  async (mode) => {
    const fixture = nativeSummaryFixture();
    await fixture.run(async () => {
      fixture.state.finish.resolve();
      const abort = new Error("synthetic injected abort");
      abort.name = "AbortError";
      const outcome = await fixture.summarize(1000, {
        prepareSimpleCompletionModel: (params) =>
          prepareSimpleCompletionModel({
            ...params,
            preparedModelRuntime: fixture.lease.snapshot,
          }),
        completeWithPreparedSimpleCompletionModel: async (params) => {
          if (mode === "completion-abort") {
            throw abort;
          }
          return await completeWithPreparedSimpleCompletionModel(params);
        },
        requireApiKey: (auth, provider) => {
          if (mode === "auth-abort") {
            throw abort;
          }
          return requireApiKey(auth, provider);
        },
      });
      if (mode === "success") {
        expect(outcome).toMatchObject({ result: { summary: "Spoken summary 42." } });
      } else if (mode === "auth-abort") {
        expect(outcome).toEqual({ error: abort });
      } else {
        expect(outcome).toMatchObject({
          error: { message: "Summarization timed out", cause: abort },
        });
      }
      expect(fixture.acquire).not.toHaveBeenCalled();
      expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
      expect(fixture.state.connections[0]?.disposals).toBe(0);
      fixture.lease.release();
      await fixture.assertClosed();
    });
  },
);

it("leaves a raw provider registration with its owner", async () => {
  const fixture = nativeSummaryFixture();
  await fixture.run(async () => {
    const raw = loadPluginRegistryHandle({ config: fixture.config });
    const snapshot = { ...fixture.lease.snapshot, pluginRegistry: raw };
    fixture.acquire.mockResolvedValue({ ...fixture.lease, snapshot });
    fixture.state.finish.resolve();
    expect(await fixture.summarize()).toMatchObject({ result: { summary: "Spoken summary 42." } });
    await fixture.parent.drain();
    const rawSource = fixture.state.connections.at(-1);
    expect(rawSource?.completionReads).toBe(1);
    expect(rawSource?.disposals).toBe(0);
    expect(rawSource?.database.isOpen).toBe(true);
  });
});
