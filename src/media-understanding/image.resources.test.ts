import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { getSessionMcpRequestSignal } from "../agents/agent-bundle-mcp-request-context.js";
import * as minimaxVlm from "../agents/minimax-vlm.js";
import * as modelAuth from "../agents/model-auth.js";
import { acquireReadOnlyPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerContextEngineInRegistry } from "../context-engine/registry.js";
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
import { withEnvAsync } from "../test-utils/env.js";
import { describeImagesWithModelCore, describeImageWithModelCore } from "./image.js";

function nativeImageFixture(
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
  api.lifecycle.registerRuntimeLifecycle({ id: "native-image", dispose() {
    connection.disposals++;
    database.close();
  }});
  api.registerProvider({
    id: ${JSON.stringify(id)}, label: "Native image", auth: [],
    async prepareRuntimeAuth() {
      if (state.holdSetupTail) {
        void state.trackWork(async () => {
          await state.finishSetupTail.promise;
          read();
          state.setupTailReads++;
        }).then(() => state.setupTailSettled.resolve(), (error) => {
          state.cancellation.failure = error;
          state.setupTailSettled.resolve();
        });
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
          void state.trackWork(async () => { await state.finishWork.promise; read(); })
            .then(() => state.workSettled.resolve(), (error) => {
              state.cancellation.failure = error;
              state.workSettled.resolve();
            });
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
  return {
    dir,
    id,
    config,
    agentDir,
    state,
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
    environment: <T>(run: () => Promise<T>) =>
      withEnvAsync(
        {
          OPENCLAW_HOME: dir,
          OPENCLAW_STATE_DIR: path.join(dir, "state"),
          OPENCLAW_CONFIG_PATH: path.join(dir, "config.json"),
        },
        run,
      ),
    cleanup() {
      state.finish.resolve();
      state.resumeSetup.resolve();
      state.finishCleanup.resolve();
      state.finishWork.resolve();
      state.finishSetupTail.resolve();
      for (const connection of connections) {
        if (connection.database.isOpen) {
          connection.database.close();
        }
      }
      Reflect.deleteProperty(globalThis, stateKey);
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await closePreparedModelRuntimeSnapshots();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it.each(["timeout", "cancellation", "late-rejection"] as const)(
  "retains the supplied generation and adopted donor after %s reports",
  async (mode) => {
    const fixture = nativeImageFixture(mode === "late-rejection");
    try {
      await fixture.environment(async () => {
        useNoBundledPlugins();
        const donor = await acquirePluginRegistryForInspection({ config: fixture.config });
        const parent = new AsyncWorkScope();
        const abort = new AbortController();
        let lease: Awaited<ReturnType<typeof acquireReadOnlyPreparedModelRuntime>> | undefined;
        let closing: Promise<void> | undefined;
        let outcome: Promise<unknown> | undefined;
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
          const acquired = await acquireReadOnlyPreparedModelRuntime(
            {
              config: fixture.config,
              agentId: "main",
              agentDir: fixture.agentDir,
              workspaceDir: fixture.dir,
              loadRuntimePlugins: true,
              skipCredentials: true,
              runtimePluginSelections: [{ provider: fixture.id, modelId: "image-model" }],
            },
            undefined,
            "static",
          );
          lease = acquired;
          expect(fixture.state.connections).toHaveLength(2);
          const [donorConnection, primary] = fixture.state.connections;
          expect(acquired.snapshot.pluginRegistry).not.toBe(primary!.registry);
          expect(acquired.snapshot.pluginRegistry?.contextEngines.get(fixture.id)).toBe(
            donor.registry.contextEngines.get(fixture.id),
          );
          vi.useFakeTimers();
          outcome = parent
            .track(() =>
              describeImageWithModelCore({
                ...fixture.request,
                preparedModelRuntime: acquired.snapshot,
                timeoutMs: 25,
                signal: abort.signal,
              }),
            )
            .catch((error: unknown) => error);
          await Promise.race([
            fixture.state.started.promise,
            outcome.then(() => {
              throw new Error("Image description settled before invoking its provider");
            }),
          ]);
          if (mode === "timeout") {
            await vi.advanceTimersByTimeAsync(25);
          } else {
            abort.abort(new Error("synthetic image cancellation"));
          }
          expect(await outcome).toEqual(
            expect.objectContaining({
              message:
                mode === "timeout"
                  ? expect.stringContaining("image description request timed out")
                  : "synthetic image cancellation",
            }),
          );
          acquired.release();
          await donor.release();
          closing = closePreparedModelRuntimeSnapshots();
          await vi.advanceTimersByTimeAsync(0);
          expect(primary!.database.isOpen).toBe(true);
          expect(donorConnection!.database.isOpen).toBe(true);
          expect(primary!.disposals).toBe(0);
          expect(donorConnection!.disposals).toBe(0);
          await expect(
            describeImageWithModelCore({
              ...fixture.request,
              preparedModelRuntime: acquired.snapshot,
            }),
          ).rejects.toThrow(/resources have been released/);
          fixture.state.finish.resolve();
          await fixture.state.settled.promise;
          await parent.drain();
          await closing;
          expect(primary!.lateReads).toBe(1);
          for (const connection of fixture.state.connections) {
            expect(connection.disposals).toBe(1);
            expect(connection.database.isOpen).toBe(false);
            const reopened = new DatabaseSync(connection.dbPath, { readOnly: true });
            try {
              expect(reopened.prepare("SELECT value FROM proof").get()?.value).toBe(42);
            } finally {
              reopened.close();
            }
          }
        } finally {
          abort.abort();
          fixture.state.finish.resolve();
          await outcome;
          await parent.drain();
          lease?.release();
          await donor.release();
          await closing;
          vi.useRealTimers();
        }
      });
    } finally {
      fixture.cleanup();
    }
  },
);

it("releases only its borrow while the supplying generation remains open", async () => {
  const fixture = nativeImageFixture();
  try {
    await fixture.environment(async () => {
      useNoBundledPlugins();
      const lease = await acquireReadOnlyPreparedModelRuntime(
        {
          config: fixture.config,
          agentId: "main",
          agentDir: fixture.agentDir,
          workspaceDir: fixture.dir,
          loadRuntimePlugins: true,
          skipCredentials: true,
          runtimePluginSelections: [{ provider: fixture.id, modelId: "image-model" }],
        },
        undefined,
        "static",
      );
      try {
        fixture.state.finish.resolve();
        expect(
          await describeImageWithModelCore({
            ...fixture.request,
            preparedModelRuntime: lease.snapshot,
          }),
        ).toMatchObject({ text: "native image 42" });
        expect(fixture.state.connections[0]!.database.isOpen).toBe(true);
        expect(fixture.state.connections[0]!.disposals).toBe(0);
      } finally {
        lease.release();
        await closePreparedModelRuntimeSnapshots();
      }
      expect(fixture.state.connections[0]!.disposals).toBe(1);
    });
  } finally {
    fixture.cleanup();
  }
});

it("leaves a raw supplied registry with its caller", async () => {
  const fixture = nativeImageFixture();
  try {
    await fixture.environment(async () => {
      useNoBundledPlugins();
      const raw = loadPluginRegistryHandle({ config: fixture.config });
      setActivePluginRegistry(raw);
      const lease = await acquireReadOnlyPreparedModelRuntime(
        {
          config: fixture.config,
          agentId: "main",
          agentDir: fixture.agentDir,
          workspaceDir: fixture.dir,
          loadRuntimePlugins: true,
          skipCredentials: true,
          runtimePluginSelections: [{ provider: fixture.id, modelId: "image-model" }],
        },
        undefined,
        "static",
      );
      try {
        fixture.state.finish.resolve();
        const snapshot = { ...lease.snapshot, pluginRegistry: raw };
        expect(
          await describeImageWithModelCore({ ...fixture.request, preparedModelRuntime: snapshot }),
        ).toMatchObject({ text: "native image 42" });
        expect(fixture.state.connections[0]!.disposals).toBe(0);
        expect(fixture.state.connections[0]!.database.isOpen).toBe(true);
      } finally {
        lease.release();
        await closePreparedModelRuntimeSnapshots();
      }
    });
  } finally {
    fixture.cleanup();
  }
});

it.each(["setup", "retry"] as const)(
  "refuses new provider work after process close during %s",
  async (phase) => {
    const fixture = nativeImageFixture();
    try {
      await fixture.environment(async () => {
        useNoBundledPlugins();
        const lease = await acquireReadOnlyPreparedModelRuntime(
          {
            config: fixture.config,
            agentId: "main",
            agentDir: fixture.agentDir,
            workspaceDir: fixture.dir,
            loadRuntimePlugins: true,
            skipCredentials: true,
            runtimePluginSelections: [{ provider: fixture.id, modelId: "image-model" }],
          },
          undefined,
          "static",
        );
        let closing: Promise<void> | undefined;
        let outcome: Promise<unknown> | undefined;
        try {
          fixture.state.holdSetup = phase === "setup";
          fixture.state.reasoningOnly = phase === "retry";
          outcome = describeImageWithModelCore({
            ...fixture.request,
            preparedModelRuntime: lease.snapshot,
          }).catch((error: unknown) => error);
          const entered = phase === "setup" ? fixture.state.setupStarted : fixture.state.started;
          await Promise.race([
            entered.promise,
            outcome.then(() => {
              throw new Error("Image request settled before the held phase");
            }),
          ]);
          lease.release();
          closing = closePreparedModelRuntimeSnapshots();
          expect(fixture.state.connections[0]!.database.isOpen).toBe(true);
          fixture.state.resumeSetup.resolve();
          fixture.state.finish.resolve();
          expect(await outcome).toEqual(
            expect.objectContaining({
              message: "Prepared plugin registry resources have been released",
            }),
          );
          await closing;
          expect(fixture.state.calls).toBe(phase === "setup" ? 0 : 1);
          expect(fixture.state.setupReads).toBe(phase === "setup" ? 1 : 0);
          expect(fixture.state.connections[0]!.lateReads).toBe(phase === "setup" ? 0 : 1);
          expect(fixture.state.connections[0]!.disposals).toBe(1);
        } finally {
          fixture.state.resumeSetup.resolve();
          fixture.state.finish.resolve();
          await outcome;
          lease.release();
          await closing;
          await closePreparedModelRuntimeSnapshots();
        }
      });
    } finally {
      fixture.cleanup();
    }
  },
);

it.each(["parent", "normal", "admitted-tail"] as const)(
  "preserves MCP cancellation and cleanup context during %s closure",
  async (mode) => {
    const fixture = nativeImageFixture();
    try {
      await fixture.environment(async () => {
        useNoBundledPlugins();
        const lease = await acquireReadOnlyPreparedModelRuntime(
          {
            config: fixture.config,
            agentId: "main",
            agentDir: fixture.agentDir,
            workspaceDir: fixture.dir,
            loadRuntimePlugins: true,
            skipCredentials: true,
            runtimePluginSelections: [{ provider: fixture.id, modelId: "image-model" }],
          },
          undefined,
          "static",
        );
        const parent = new AsyncWorkScope();
        let result: Promise<unknown> | undefined;
        let closing: Promise<void> | undefined;
        try {
          fixture.state.watchCancellation = true;
          fixture.state.holdWork = mode === "admitted-tail";
          result = parent.track(() =>
            withPluginRuntimeGenerationScope(lease.snapshot, () =>
              describeImageWithModelCore({
                ...fixture.request,
                preparedModelRuntime: lease.snapshot,
              }),
            ),
          );
          await Promise.race([
            fixture.state.started.promise,
            result.then(() => {
              throw new Error("Provider did not enter before reporting its result");
            }),
          ]);
          if (mode === "parent") {
            const reason = new Error("synthetic parent close");
            withPluginRuntimeGenerationScope(
              {
                metadataSnapshot: lease.snapshot.metadataSnapshot,
                pluginRegistry: createEmptyPluginRegistry(),
              },
              () => parent.beginClose(reason),
            );
            expect(fixture.state.cancellation.signal?.aborted).toBe(true);
            expect(fixture.state.cancellation.signal?.reason).toBe(reason);
          } else {
            fixture.state.finish.resolve();
            expect(await result).toMatchObject({ text: "native image 42" });
            if (mode === "admitted-tail") {
              expect(fixture.state.cancellation.signal?.aborted).toBe(false);
              fixture.state.finishWork.resolve();
              await fixture.state.workSettled.promise;
            }
          }
          await fixture.state.cleanupStarted.promise;
          expect(fixture.state.cancellation.cleanupSignal?.aborted).toBe(true);
          expect(fixture.state.cancellation.cleanupSignal?.reason).toBe(
            fixture.state.cancellation.signal?.reason,
          );
          expect(fixture.state.cancellation.registry).toBe(lease.snapshot.pluginRegistry);
          lease.release();
          closing = closePreparedModelRuntimeSnapshots();
          expect(fixture.state.connections[0]!.database.isOpen).toBe(true);
          fixture.state.finish.resolve();
          expect(await result).toMatchObject({ text: "native image 42" });
          fixture.state.finishCleanup.resolve();
          await parent.drain();
          await closing;
          expect(fixture.state.cancellation.failure).toBeUndefined();
          expect(fixture.state.cancellation.afterRegistry).toBe(lease.snapshot.pluginRegistry);
          expect(fixture.state.connections[0]!.cleanupReads).toBe(1);
          expect(fixture.state.connections[0]!.disposals).toBe(1);
        } finally {
          fixture.state.finish.resolve();
          fixture.state.finishWork.resolve();
          fixture.state.finishCleanup.resolve();
          await result;
          await parent.drain();
          lease.release();
          await closing;
          await closePreparedModelRuntimeSnapshots();
        }
      });
    } finally {
      fixture.cleanup();
    }
  },
);

it.each(["success", "failure", "timeout"] as const)(
  "retains native resources through auth descendants after setup %s",
  async (mode) => {
    const fixture = nativeImageFixture();
    try {
      await fixture.environment(async () => {
        useNoBundledPlugins();
        const lease = await acquireReadOnlyPreparedModelRuntime(
          {
            config: fixture.config,
            agentId: "main",
            agentDir: fixture.agentDir,
            workspaceDir: fixture.dir,
            loadRuntimePlugins: true,
            skipCredentials: true,
            runtimePluginSelections: [{ provider: fixture.id, modelId: "image-model" }],
          },
          undefined,
          "static",
        );
        const parent = new AsyncWorkScope();
        let outcome: Promise<unknown> | undefined;
        let closing: Promise<void> | undefined;
        try {
          fixture.state.holdSetup = true;
          fixture.state.holdSetupTail = true;
          fixture.state.rejectSetup = mode === "failure";
          fixture.state.finish.resolve();
          vi.useFakeTimers();
          outcome = parent
            .track(() =>
              describeImageWithModelCore({
                ...fixture.request,
                preparedModelRuntime: lease.snapshot,
                timeoutMs: 25,
              }),
            )
            .catch((error: unknown) => error);
          await Promise.race([
            fixture.state.setupStarted.promise,
            outcome.then(() => {
              throw new Error("Setup did not enter the auth hook");
            }),
          ]);
          if (mode === "timeout") {
            await vi.advanceTimersByTimeAsync(25);
            expect(await outcome).toEqual(
              expect.objectContaining({
                message: expect.stringContaining("image description setup timed out"),
              }),
            );
          }
          fixture.state.resumeSetup.resolve();
          const result = await outcome;
          if (mode === "success") {
            expect(result).toMatchObject({ text: "native image 42" });
          } else if (mode === "failure") {
            expect(result).toEqual(expect.objectContaining({ message: "synthetic setup failure" }));
          }
          // Let the auth callback return after its deadline while its descendant is still held.
          await vi.advanceTimersByTimeAsync(0);
          expect(fixture.state.setupReads).toBe(1);
          expect(fixture.state.calls).toBe(mode === "success" ? 1 : 0);
          lease.release();
          closing = closePreparedModelRuntimeSnapshots();
          await vi.advanceTimersByTimeAsync(0);
          expect(fixture.state.connections[0]!.database.isOpen).toBe(true);
          fixture.state.finishSetupTail.resolve();
          await fixture.state.setupTailSettled.promise;
          await parent.drain();
          await closing;
          expect(fixture.state.cancellation.failure).toBeUndefined();
          expect(fixture.state.setupTailReads).toBe(1);
          expect(fixture.state.connections[0]!.disposals).toBe(1);
          const reopened = new DatabaseSync(fixture.state.connections[0]!.dbPath, {
            readOnly: true,
          });
          try {
            expect(reopened.prepare("SELECT value FROM proof").get()?.value).toBe(42);
          } finally {
            reopened.close();
          }
        } finally {
          fixture.state.resumeSetup.resolve();
          fixture.state.finishSetupTail.resolve();
          await outcome;
          await parent.drain();
          lease.release();
          await closing;
          vi.useRealTimers();
        }
      });
    } finally {
      fixture.cleanup();
    }
  },
);

it.each(["open", "resolved", "fallback"] as const)(
  "fences MiniMax image admission while the managed owner is %s",
  async (mode) => {
    const fixture = nativeImageFixture(false, {
      provider: "minimax",
      model: "MiniMax-VL-01",
      input: mode === "fallback" ? ["text"] : ["text", "image"],
    });
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    try {
      await fixture.environment(async () => {
        useNoBundledPlugins();
        const lease = await acquireReadOnlyPreparedModelRuntime(
          {
            config: fixture.config,
            agentId: "main",
            agentDir: fixture.agentDir,
            workspaceDir: fixture.dir,
            loadRuntimePlugins: true,
            skipCredentials: true,
            runtimePluginSelections: [{ provider: fixture.id, modelId: fixture.request.model }],
          },
          undefined,
          "static",
        );
        const parent = new AsyncWorkScope();
        const read = () =>
          fixture.state.connections[0]!.database.prepare("SELECT value FROM proof").get()?.value;
        const request = vi
          .spyOn(minimaxVlm, "minimaxUnderstandImage")
          .mockImplementation(async () => {
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
        let closing: Promise<void> | undefined;
        try {
          outcome = parent
            .track(() =>
              describeImagesWithModelCore({
                ...fixture.request,
                preparedModelRuntime: lease.snapshot,
                images: [fixture.request, fixture.request],
              }),
            )
            .catch((error: unknown) => error);
          if (mode !== "open") {
            await Promise.race([
              entered.promise,
              outcome.then(() => {
                throw new Error("MiniMax did not enter the held boundary");
              }),
            ]);
            lease.release();
            closing = closePreparedModelRuntimeSnapshots();
            expect(read()).toBe(42);
            resume.resolve();
            expect(await outcome).toEqual(
              expect.objectContaining({
                message: "Prepared plugin registry resources have been released",
              }),
            );
          } else {
            expect(await outcome).toMatchObject({
              text: "Image 1:\nnative MiniMax image\n\nImage 2:\nnative MiniMax image",
            });
          }
          expect(request).toHaveBeenCalledTimes(mode === "open" ? 2 : mode === "resolved" ? 1 : 0);
          await parent.drain();
          lease.release();
          await closing;
          await closePreparedModelRuntimeSnapshots();
          expect(fixture.state.connections[0]!.disposals).toBe(1);
          const reopened = new DatabaseSync(fixture.state.connections[0]!.dbPath, {
            readOnly: true,
          });
          try {
            expect(reopened.prepare("SELECT value FROM proof").get()?.value).toBe(42);
          } finally {
            reopened.close();
          }
        } finally {
          resume.resolve();
          await outcome;
          await parent.drain();
          lease.release();
          await closing;
          request.mockRestore();
          auth?.mockRestore();
        }
      });
    } finally {
      fixture.cleanup();
    }
  },
);
