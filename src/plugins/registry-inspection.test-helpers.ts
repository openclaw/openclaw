import type { DatabaseSync } from "node:sqlite";
import {
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { acquirePluginRegistryForInspection } from "./loader.js";
import { useNoBundledPlugins, writePlugin } from "./loader.test-fixtures.js";

type InspectionConnection = {
  database: DatabaseSync;
  disposals: number;
  cleanups: number;
  instanceDisposals: number;
};
let inspectionFixtureId = 0;

export function createInspectionFixture(options?: {
  registration?: "throw" | "async-resolve" | "async-reject" | "thenable" | "tracked";
  pauseDisposal?: boolean;
  disposalFailure?: boolean;
  contextEngine?: boolean;
  capturedDisposal?: "async-context" | "work-tracker" | "sibling-tracker";
  queuedAbortCleanup?: boolean;
  capturedInstanceDisposal?: boolean;
}) {
  useNoBundledPlugins();
  const id = `owned-inspection-${inspectionFixtureId++}`;
  const key = `__openclaw_${id}`;
  const connections: InspectionConnection[] = [];
  const resume = createDeferredCore();
  const finishDisposal = createDeferredCore();
  const disposalStarted = createDeferredCore();
  const disposed = createDeferredCore();
  const sibling: {
    read?: () => unknown;
    result?: unknown;
    track?: (run: () => Promise<void>) => Promise<void>;
  } = {};
  const captured: {
    registrationSignal?: AbortSignal;
    disposalSignal?: AbortSignal;
    instanceSignal?: AbortSignal;
    read?: unknown;
    abortCleanup?: Promise<void>;
    abortRead?: unknown;
    tracker?: ReturnType<typeof captureAsyncWorkTracker>;
  } = {};
  const state = {
    connections,
    resume,
    finishDisposal,
    disposalStarted,
    disposed,
    sibling,
    captured,
    captureAsyncWorkTracker,
    getAsyncWorkSignal,
    trackAsyncWork,
    lateRead: 0,
    factoryCalls: 0,
    thenCalls: 0,
  };
  Object.defineProperty(globalThis, key, { value: state, configurable: true });
  const plugin = writePlugin({
    id,
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = {
  id: ${JSON.stringify(id)},
  register(api) {
    const state = globalThis[${JSON.stringify(key)}];
    const database = new DatabaseSync(":memory:");
    const connection = { database, disposals: 0, cleanups: 0, instanceDisposals: 0 };
    state.connections.push(connection);
    const captureMode = ${JSON.stringify(options?.capturedDisposal)};
    const listener = () => {};
    process.on(${JSON.stringify(key)}, listener);
    const disposeInstance = () => {
      process.removeListener(${JSON.stringify(key)}, listener);
      connection.instanceDisposals++;
    };
    if (${options?.capturedInstanceDisposal === true}) {
      const track = state.captureAsyncWorkTracker();
      api.lifecycle.onDispose(() => track(async () => {
        await require("node:fs/promises").readFile(__filename);
        state.captured.instanceSignal = state.getAsyncWorkSignal();
        disposeInstance();
      }));
    } else {
      api.lifecycle.onDispose(disposeInstance);
    }
    class NativeLifecycle {
      id = " native-resource ";
      #database = database;
      async dispose() {
        connection.disposals++;
        if (captureMode) state.captured.disposalSignal = state.getAsyncWorkSignal();
        state.disposalStarted.resolve();
        if (${options?.pauseDisposal === true}) await state.finishDisposal.promise;
        if (captureMode === "sibling-tracker") state.sibling.result = state.sibling.read();
        if (captureMode) state.captured.read = this.#database.prepare("SELECT 42 AS value").get();
        this.#database.close();
        state.disposed.resolve();
        if (${options?.disposalFailure === true}) throw new Error("fixture disposal failed");
      }
      cleanup = () => {
        connection.cleanups++;
        if (database.isOpen) database.close();
      };
    }
    const lifecycle = new NativeLifecycle();
    if (${options?.queuedAbortCleanup === true}) {
      const track = state.captureAsyncWorkTracker();
      state.getAsyncWorkSignal().addEventListener("abort", () => queueMicrotask(() => {
        state.captured.abortCleanup = track(async () => {
          await require("node:fs/promises").readFile(__filename);
          state.captured.abortRead = database.prepare("SELECT 42 AS value").get();
          state.sibling.result = state.sibling.read?.();
        });
        void state.captured.abortCleanup.catch(() => {});
      }), { once: true });
    }
    if (captureMode) {
      state.captured.registrationSignal = state.getAsyncWorkSignal();
      const dispose = lifecycle.dispose.bind(lifecycle);
      const track = state.captured.tracker = state.captureAsyncWorkTracker();
      lifecycle.dispose = captureMode === "async-context"
        ? require("node:async_hooks").AsyncLocalStorage.bind(() => state.trackAsyncWork(dispose))
        : captureMode === "sibling-tracker" ? () => state.sibling.track(dispose) : () => track(dispose);
    }
    api.registerRuntimeLifecycle(lifecycle);
    if (${options?.contextEngine === true}) {
      api.registerContextEngine(${JSON.stringify(id)}, () => {
        state.factoryCalls++;
        throw new Error("Discovery must not invoke the context engine factory");
      });
    }
    const mode = ${JSON.stringify(options?.registration)};
    if (mode === "throw") throw new Error("fixture registration failed");
    const finishRegistration = async () => {
      await state.resume.promise;
      state.lateRead = database.prepare("SELECT 42 AS value").get().value;
      state.sibling.result = state.sibling.read?.();
      if (mode === "async-reject") throw new Error("late registration failure");
    };
    if (mode === "thenable") return { then(resolve, reject) {
      state.thenCalls++;
      finishRegistration().then(resolve, reject);
    } };
    if (mode === "tracked") {
      void state.trackAsyncWork(finishRegistration);
    } else if (mode?.startsWith("async")) return finishRegistration();
  },
};`,
  });
  const config = {
    plugins: {
      allow: [id],
      load: { paths: [plugin.file] },
      slots: { memory: "none", ...(options?.contextEngine ? { contextEngine: id } : {}) },
    },
  };
  return {
    plugin,
    event: key,
    config,
    state,
    connection(index = 0) {
      const connection = connections[index];
      if (!connection) {
        throw new Error(`Missing native inspection connection ${index}`);
      }
      return connection;
    },
    async cleanup(
      inspection?: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>,
      borrowed?: { release: () => Promise<void> },
    ) {
      resume.resolve();
      finishDisposal.resolve();
      await borrowed?.release().catch(() => undefined);
      await inspection?.release().catch(() => undefined);
      for (const connection of connections) {
        if (connection.database.isOpen) {
          connection.database.close();
        }
      }
      // This synthetic event belongs only to this fixture, including failed cleanup probes.
      process.removeAllListeners(key);
      Reflect.deleteProperty(globalThis, key);
    },
  };
}

export function acquireFixtureInspection(
  fixtures: Array<ReturnType<typeof createInspectionFixture>>,
) {
  return acquirePluginRegistryForInspection({
    config: {
      plugins: {
        allow: fixtures.map((fixture) => fixture.plugin.id),
        load: { paths: fixtures.map((fixture) => fixture.plugin.file) },
        slots: { memory: "none" },
      },
    },
  });
}
