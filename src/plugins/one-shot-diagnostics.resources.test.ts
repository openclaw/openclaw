import { AsyncResource } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
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
  startOneShotDiagnosticsExporters as startWithoutHost,
  type OneShotDiagnosticsHandle,
} from "./one-shot-diagnostics.js";
import { createOneShotDiagnosticsTestHost } from "./one-shot-diagnostics.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "./runtime.js";
import { startPluginServices } from "./services.test-support.js";
import type { OpenClawPluginServiceContext } from "./types.js";

type NativeConnection = {
  database: DatabaseSync;
  disposals: number;
  stops: number;
  lateRead?: number;
  context?: OpenClawPluginServiceContext;
};
let fixtureSequence = 0;
let host: ReturnType<typeof createOneShotDiagnosticsTestHost>;
const startOneShotDiagnosticsExporters: typeof startWithoutHost = (params) => host.start(params);

beforeEach(() => {
  host = createOneShotDiagnosticsTestHost();
});

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

type NativeFixture = ReturnType<typeof createNativeExporter>;

function expectConnection(
  fixture: NativeFixture,
  expected: Partial<NativeConnection> & { open: boolean },
) {
  const connection = fixture.connection();
  expect({ ...connection, open: connection.database.isOpen }).toMatchObject(expected);
}

async function startExporter(fixture: NativeFixture) {
  const handle = await startOneShotDiagnosticsExporters({ config: fixture.config });
  if (!handle) {
    throw new Error("Native exporter did not produce a one-shot handle");
  }
  return handle;
}

afterEach(() => {
  vi.useRealTimers();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("disposes the actual exporter database after successful service stop", async () => {
  const fixture = createNativeExporter();
  const active = createEmptyPluginRegistry();
  setActivePluginRegistry(active);
  let handle: OneShotDiagnosticsHandle | undefined;
  try {
    handle = await startExporter(fixture);
    const connection = fixture.connection();
    expectConnection(fixture, { open: true });
    expect(connection.context?.internalDiagnostics).toBeUndefined();
    fixture.state.finishStop.resolve();
    await handle.stop();
    expect(connection.lateRead).toBe(42);
    await vi.waitFor(() => expectConnection(fixture, { open: false }));
    expect(connection.disposals).toBe(1);
    await handle.stop();
    expectConnection(fixture, { open: false, stops: 1, disposals: 1 });
    expect(getActivePluginRegistry()).toBe(active);
  } finally {
    await fixture.cleanup(handle);
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
    expectConnection(fixture, { open: true });
    fixture.state.finishDisposal.resolve();
    await expect(starting).resolves.toBeNull();
    expectConnection(fixture, { open: false, disposals: 1 });
  } finally {
    fixture.state.finishDisposal.resolve();
    await starting;
    await fixture.cleanup();
  }
});

it.each([false, true])(
  "retains pending disposal in a live stop caller (repeated stop: %s)",
  async (repeat) => {
    const fixture = createNativeExporter({ pauseDisposal: true });
    const handle = await startExporter(fixture);
    const caller = new AsyncWorkScope();
    let draining: Promise<void> | undefined;
    try {
      fixture.state.finishStop.resolve();
      const firstStop = repeat ? handle.stop() : undefined;
      await firstStop;
      if (repeat) {
        await fixture.state.disposalStarted.promise;
      }
      const stopping = caller.track(() => {
        const stop = handle.stop();
        if (repeat) {
          expect(stop).toBe(firstStop);
        }
        return stop;
      });
      await fixture.state.disposalStarted.promise;
      await stopping;
      const drained = vi.fn<() => void>();
      draining = caller.drain().then(drained);
      await nextEventLoopTurn();
      expect(drained).not.toHaveBeenCalled();
      expectConnection(fixture, { open: true });
      fixture.state.finishDisposal.resolve();
      await draining;
      expectConnection(fixture, { open: false, disposals: 1, stops: 1 });
      if (!repeat) {
        const repeatedStop = handle.stop();
        await repeatedStop;
        expect(handle.stop()).toBe(repeatedStop);
        expectConnection(fixture, { open: false, disposals: 1, stops: 1 });
      }
    } finally {
      fixture.state.finishDisposal.resolve();
      await draining;
      await caller.drain();
      await fixture.cleanup(handle);
    }
  },
);

it.each([false, true])(
  "retains timed-out service cleanup in the caller scope (failed start: %s)",
  async (failStart) => {
    const fixture = createNativeExporter({ failStart });
    const acquired = await acquirePluginRegistryForInspection({ config: fixture.config });
    const caller = new AsyncWorkScope();
    const broadcast = vi.fn();
    let starting: ReturnType<typeof startPluginServices> | undefined;
    let released: Promise<void> | undefined;
    try {
      // One-shot service views omit the inspection runtime binding.
      const start = () =>
        startPluginServices({
          registry: { ...acquired.registry },
          config: fixture.config,
          ...(failStart ? {} : { broadcastPluginEvent: broadcast }),
          oneShotStopTimeouts: { eventDrainMs: 5_000, serviceStopMs: 10_000 },
        });
      if (failStart) {
        vi.useFakeTimers();
      }
      starting = failStart ? start() : caller.track(start);
      if (failStart) {
        await fixture.state.stopStarted.promise;
        await vi.advanceTimersByTimeAsync(5_000);
      }
      const services = await starting;
      if (!failStart) {
        vi.useFakeTimers();
      }
      const stopping = caller.track(() => services.stop());
      const observed = expect(stopping).resolves.toMatchObject({
        errors: [expect.objectContaining({ message: expect.stringContaining("timed out") })],
      });
      await fixture.state.stopStarted.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await observed;
      if (!failStart) {
        expect(() =>
          fixture.connection().context?.gatewayEvents?.emit("late", {}, { scope: "operator.read" }),
        ).toThrow("no longer active");
        expect(broadcast).not.toHaveBeenCalled();
      }
      released = caller.drain().then(() => acquired.release());
      await nextEventLoopTurn();
      expectConnection(fixture, { open: true, stops: 1 });
      fixture.state.finishStop.resolve();
      await fixture.state.stopFinished.promise;
      await released;
      expectConnection(fixture, { lateRead: 42, open: false, disposals: 1 });
    } finally {
      fixture.state.finishStop.resolve();
      await starting;
      await fixture.state.stopFinished.promise;
      await caller.drain();
      await released;
      await acquired.release();
      await fixture.cleanup();
    }
  },
);

it("disposes resources when a retained stop callback restores a closed startup scope", async () => {
  const fixture = createNativeExporter();
  const startup = new AsyncWorkScope();
  let handle: OneShotDiagnosticsHandle | null | undefined;
  const retainedStop = await startup.track(async () => {
    handle = await startExporter(fixture);
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
      const stopped = vi.fn<() => void>();
      stopping = handle?.stop().then(stopped);
      await fixture.state.stopStarted.promise;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(stopped).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toHaveBeenCalledOnce();
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
