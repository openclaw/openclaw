import { AsyncResource } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { acquirePluginRegistryForInspection } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import {
  startOneShotDiagnosticsExporters,
  type OneShotDiagnosticsHandle,
} from "./one-shot-diagnostics.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "./runtime.js";
import { startPluginServices } from "./services.js";
import type { OpenClawPluginServiceContext } from "./types.js";

type NativeConnection = {
  database: DatabaseSync;
  disposals: number;
  stops: number;
  lateRead?: number;
  context?: OpenClawPluginServiceContext;
};
let fixtureSequence = 0;

function createNativeExporter(
  options: { service?: boolean; failStart?: boolean; pauseDisposal?: boolean } = {},
) {
  useNoBundledPlugins();
  const key = `__openclaw_one_shot_native_${fixtureSequence++}`;
  const connections: NativeConnection[] = [];
  const state = {
    connections,
    started: createDeferredCore(),
    stopStarted: createDeferredCore(),
    finishStop: createDeferredCore(),
    stopFinished: createDeferredCore(),
    disposalStarted: createDeferredCore(),
    finishDisposal: createDeferredCore(),
  };
  if (!options.pauseDisposal) {
    state.finishDisposal.resolve();
  }
  Object.defineProperty(globalThis, key, { value: state, configurable: true });
  const plugin = writePlugin({
    id: "diagnostics-otel",
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = {
  id: "diagnostics-otel",
  register(api) {
    const state = globalThis[${JSON.stringify(key)}];
    const database = new DatabaseSync(":memory:");
    const connection = { database, disposals: 0, stops: 0 };
    state.connections.push(connection);
    api.registerRuntimeLifecycle({
      id: "native-exporter-database",
      async dispose() {
        connection.disposals++;
        state.disposalStarted.resolve();
        await state.finishDisposal.promise;
        database.close();
      },
    });
    if (${options.service !== false}) api.registerService({
      id: "diagnostics-otel",
      start(context) {
        connection.context = context;
        state.started.resolve();
        if (${options.failStart === true}) throw new Error("native exporter start failed");
      },
      async stop() {
        connection.stops++;
        state.stopStarted.resolve();
        try {
          await state.finishStop.promise;
          connection.lateRead = database.prepare("SELECT 42 AS value").get().value;
        } finally {
          state.stopFinished.resolve();
        }
      },
    });
  },
};`,
  });
  const config = {
    diagnostics: { otel: { enabled: true } },
    plugins: {
      allow: [plugin.id],
      load: { paths: [plugin.file] },
      slots: { memory: "none" },
    },
  };
  return {
    config,
    state,
    connection() {
      const connection = connections[0];
      if (!connection) {
        throw new Error("Native exporter did not register its database");
      }
      return connection;
    },
    async cleanup(handle?: OneShotDiagnosticsHandle | null) {
      state.finishStop.resolve();
      state.finishDisposal.resolve();
      await handle?.stop();
      for (const connection of connections) {
        if (connection.stops > 0) {
          await state.stopFinished.promise;
        }
        if (connection.database.isOpen) {
          connection.database.close();
        }
      }
      Reflect.deleteProperty(globalThis, key);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("one-shot diagnostics registration resources", () => {
  it("disposes the actual exporter database after successful service stop", async () => {
    const fixture = createNativeExporter();
    const active = createEmptyPluginRegistry();
    setActivePluginRegistry(active);
    let handle: OneShotDiagnosticsHandle | null | undefined;
    try {
      handle = await startOneShotDiagnosticsExporters({ config: fixture.config });
      const connection = fixture.connection();
      expect(handle).not.toBeNull();
      expect(connection.database.isOpen).toBe(true);
      expect(connection.context?.internalDiagnostics).toBeUndefined();
      fixture.state.finishStop.resolve();
      await handle?.stop();
      expect(connection.lateRead).toBe(42);
      await vi.waitFor(() => expect(connection.database.isOpen).toBe(false));
      expect(connection.disposals).toBe(1);
      await handle?.stop();
      expect(connection.stops).toBe(1);
      expect(connection.disposals).toBe(1);
      expect(getActivePluginRegistry()).toBe(active);
    } finally {
      await fixture.cleanup(handle);
    }
  });

  it("disposes a loaded registry when it has no exporter service", async () => {
    const fixture = createNativeExporter({ service: false });
    try {
      await expect(
        startOneShotDiagnosticsExporters({ config: fixture.config }),
      ).resolves.toBeNull();
      await vi.waitFor(() => expect(fixture.connection().database.isOpen).toBe(false));
      expect(fixture.connection().disposals).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("waits for actual registration disposal before returning no-service null", async () => {
    const fixture = createNativeExporter({ service: false, pauseDisposal: true });
    let returned = false;
    const starting = startOneShotDiagnosticsExporters({ config: fixture.config }).then((handle) => {
      returned = true;
      return handle;
    });
    try {
      await fixture.state.disposalStarted.promise;
      await nextEventLoopTurn();
      expect(returned).toBe(false);
      expect(fixture.connection().database.isOpen).toBe(true);
      fixture.state.finishDisposal.resolve();
      await expect(starting).resolves.toBeNull();
      expect(fixture.connection().database.isOpen).toBe(false);
      expect(fixture.connection().disposals).toBe(1);
    } finally {
      fixture.state.finishDisposal.resolve();
      await starting;
      await fixture.cleanup();
    }
  });

  it("retains slow registration disposal in the actual stop caller's work scope", async () => {
    const fixture = createNativeExporter({ pauseDisposal: true });
    const handle = await startOneShotDiagnosticsExporters({ config: fixture.config });
    if (!handle) {
      throw new Error("Native exporter did not produce a one-shot handle");
    }
    const caller = new AsyncWorkScope();
    let draining: Promise<void> | undefined;
    try {
      fixture.state.finishStop.resolve();
      const stopping = caller.track(() => handle.stop());
      await fixture.state.disposalStarted.promise;
      await stopping;
      let drained = false;
      draining = caller.drain().then(() => {
        drained = true;
      });
      await nextEventLoopTurn();
      expect(drained).toBe(false);
      expect(fixture.connection().database.isOpen).toBe(true);
      fixture.state.finishDisposal.resolve();
      await draining;
      expect(fixture.connection().database.isOpen).toBe(false);
      expect(fixture.connection().disposals).toBe(1);
      const repeatedStop = handle.stop();
      await repeatedStop;
      expect(handle.stop()).toBe(repeatedStop);
      expect(fixture.connection().stops).toBe(1);
      expect(fixture.connection().disposals).toBe(1);
    } finally {
      fixture.state.finishDisposal.resolve();
      await draining;
      await caller.drain();
      await fixture.cleanup(handle);
    }
  });

  it("retains pending registration disposal for a second live stop caller", async () => {
    const fixture = createNativeExporter({ pauseDisposal: true });
    const handle = await startOneShotDiagnosticsExporters({ config: fixture.config });
    if (!handle) {
      throw new Error("Native exporter did not produce a one-shot handle");
    }
    const caller = new AsyncWorkScope();
    let draining: Promise<void> | undefined;
    try {
      fixture.state.finishStop.resolve();
      const firstStop = handle.stop();
      await firstStop;
      await fixture.state.disposalStarted.promise;
      let repeatedStop: Promise<void> | undefined;
      await caller.track(() => {
        repeatedStop = handle.stop();
        return repeatedStop;
      });
      expect(repeatedStop).toBe(firstStop);
      let drained = false;
      draining = caller.drain().then(() => {
        drained = true;
      });
      await nextEventLoopTurn();
      expect(drained).toBe(false);
      expect(fixture.connection().database.isOpen).toBe(true);
      fixture.state.finishDisposal.resolve();
      await draining;
      expect(fixture.connection().database.isOpen).toBe(false);
      expect(fixture.connection().disposals).toBe(1);
      expect(fixture.connection().stops).toBe(1);
    } finally {
      fixture.state.finishDisposal.resolve();
      await draining;
      await caller.drain();
      await fixture.cleanup(handle);
    }
  });

  it("retains cached failed-start cleanup in a later stop caller's work scope", async () => {
    const fixture = createNativeExporter({ failStart: true });
    const acquired = await acquirePluginRegistryForInspection({ config: fixture.config });
    const caller = new AsyncWorkScope();
    let starting: ReturnType<typeof startPluginServices> | undefined;
    let released: Promise<void> | undefined;
    vi.useFakeTimers();
    try {
      starting = startPluginServices({
        registry: acquired.registry,
        config: fixture.config,
        oneShotStopTimeouts: { eventDrainMs: 5_000, serviceStopMs: 10_000 },
      });
      await fixture.state.stopStarted.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      const services = await starting;
      const stopping = caller.track(() => services.stop());
      const rejected = expect(stopping).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      released = caller.drain().then(() => acquired.release());
      await nextEventLoopTurn();
      expect(fixture.connection().database.isOpen).toBe(true);
      expect(fixture.connection().stops).toBe(1);
      fixture.state.finishStop.resolve();
      await fixture.state.stopFinished.promise;
      await released;
      expect(fixture.connection().lateRead).toBe(42);
      expect(fixture.connection().database.isOpen).toBe(false);
      expect(fixture.connection().disposals).toBe(1);
    } finally {
      fixture.state.finishStop.resolve();
      await starting;
      await fixture.state.stopFinished.promise;
      await caller.drain();
      await released;
      await acquired.release();
      await fixture.cleanup();
    }
  });

  it("disposes resources when a retained stop callback restores a closed startup scope", async () => {
    const fixture = createNativeExporter();
    const startup = new AsyncWorkScope();
    let handle: OneShotDiagnosticsHandle | null | undefined;
    const retainedStop = await startup.track(async () => {
      handle = await startOneShotDiagnosticsExporters({ config: fixture.config });
      if (!handle) {
        throw new Error("Native exporter did not produce a one-shot handle");
      }
      return AsyncResource.bind(handle.stop);
    });
    await startup.drain();
    try {
      fixture.state.finishStop.resolve();
      await retainedStop();
      expect(fixture.connection().lateRead).toBe(42);
      expect(fixture.connection().stops).toBe(1);
      await vi.waitFor(() => expect(fixture.connection().database.isOpen).toBe(false));
      expect(fixture.connection().disposals).toBe(1);
    } finally {
      await fixture.cleanup(handle);
    }
  });

  it.each([false, true])(
    "retains the native database beyond the flush deadline (failed start: %s)",
    async (failStart) => {
      const fixture = createNativeExporter({ failStart });
      let handle: OneShotDiagnosticsHandle | null | undefined;
      let starting: Promise<OneShotDiagnosticsHandle | null> | undefined;
      let stopping: Promise<void> | undefined;
      vi.useFakeTimers();
      try {
        starting = startOneShotDiagnosticsExporters({ config: fixture.config });
        await fixture.state.started.promise;
        if (failStart) {
          await fixture.state.stopStarted.promise;
          await vi.advanceTimersByTimeAsync(5_000);
        }
        handle = await starting;
        const connection = fixture.connection();
        expect(handle).not.toBeNull();
        expect(connection.context?.internalDiagnostics).toBeUndefined();
        let stopped = false;
        stopping = handle?.stop().then(() => {
          stopped = true;
        });
        await fixture.state.stopStarted.promise;
        await vi.advanceTimersByTimeAsync(9_999);
        expect(stopped).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await stopping;
        expect(stopped).toBe(true);
        expect(connection.database.isOpen).toBe(true);
        expect(connection.disposals).toBe(0);
        expect(connection.stops).toBe(1);

        fixture.state.finishStop.resolve();
        await fixture.state.stopFinished.promise;
        vi.useRealTimers();
        expect(connection.lateRead).toBe(42);
        await vi.waitFor(() => expect(connection.database.isOpen).toBe(false));
        expect(connection.disposals).toBe(1);
      } finally {
        fixture.state.finishStop.resolve();
        await starting;
        await stopping;
        await fixture.cleanup(handle);
      }
    },
  );

  it("keeps raw service cleanup in the caller's work scope after the stop observer times out", async () => {
    const fixture = createNativeExporter();
    const acquired = await acquirePluginRegistryForInspection({ config: fixture.config });
    const work = new AsyncWorkScope();
    const broadcast = vi.fn();
    const services = await work.track(() =>
      startPluginServices({
        registry: acquired.registry,
        config: fixture.config,
        broadcastPluginEvent: broadcast,
        oneShotStopTimeouts: { eventDrainMs: 5_000, serviceStopMs: 10_000 },
      }),
    );
    let released: Promise<void> | undefined;
    vi.useFakeTimers();
    try {
      const stopping = work.track(() => services.stop());
      const rejected = expect(stopping).rejects.toThrow("timed out");
      await fixture.state.stopStarted.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(() =>
        fixture.connection().context?.gatewayEvents?.emit("late", {}, { scope: "operator.read" }),
      ).toThrow("no longer active");
      expect(broadcast).not.toHaveBeenCalled();
      released = work.drain().then(() => acquired.release());
      await nextEventLoopTurn();
      expect(fixture.connection().database.isOpen).toBe(true);
      fixture.state.finishStop.resolve();
      await fixture.state.stopFinished.promise;
      await released;
      expect(fixture.connection().lateRead).toBe(42);
      expect(fixture.connection().database.isOpen).toBe(false);
      expect(fixture.connection().disposals).toBe(1);
    } finally {
      fixture.state.finishStop.resolve();
      await fixture.state.stopFinished.promise;
      await work.drain();
      await released;
      await acquired.release();
      await fixture.cleanup();
    }
  });
});
