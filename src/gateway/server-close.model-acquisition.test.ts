import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { getPreparedModelCatalogWorkerPoolSnapshot } from "../agents/prepared-model-catalog-worker.js";
import {
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "../agents/prepared-model-runtime.js";
import { registerPreparedModelRuntimeClose } from "../agents/prepared-model-runtime.lifecycle.js";
import { getPreparedModelRuntimeStartupStatus } from "../agents/prepared-model-runtime.startup-status.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { GATEWAY_SHUTDOWN_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { flushLogger, setLoggerOverride } from "../logging/logger.js";
import { getPluginValueInstance } from "../plugins/plugin-instance-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { publishConfiguredModelRuntimeSnapshots } from "./server-startup-model-runtime.js";

const auditMaintenance = vi.hoisted(() => ({
  gate: undefined as { entered: () => void; release: Promise<void> } | undefined,
}));

type Fixture = Awaited<ReturnType<typeof createGatewayMetadataCloseFixture>>;

async function writeCatalog(
  fixture: Fixture,
  acquisition: ReturnType<typeof holdAcquisition>,
  models: string[],
  phase = "static catalog",
) {
  const bridgeKey = `__model_close_${path.basename(fixture.state.root)}`;
  Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: acquisition.run });
  const invoke = `await globalThis[${JSON.stringify(bridgeKey)}](ctx.signal);`;
  await fs.writeFile(
    path.join(fixture.rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: fixture.pluginId,
      providers: [fixture.pluginId],
      providerCatalogEntry: "./catalog.cjs",
      configSchema: { type: "object", properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(fixture.rootDir, "catalog.cjs"),
    `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, label: "Acquisition fixture", auth: [],
      staticCatalog: { async run(ctx) {
        ${phase === "static catalog" ? invoke : ""}
        return { provider: { api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
          models: ${JSON.stringify(models)}.map(id => ({ id, name: id, reasoning: false, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 })) } };
      } },
      ${phase === "synthetic auth" ? `async prepareSyntheticAuth(ctx) { ${invoke} return { apiKey: "synthetic-fixture-key" }; },` : ""}
    };`,
  );
  return bridgeKey;
}

function beforeCompletion(entered: Promise<unknown>, completing: Promise<unknown>) {
  return Promise.race([
    entered,
    completing.then(() => {
      throw new Error("Operation completed before entering its lifecycle gate");
    }),
  ]);
}

function holdAcquisition(accept: () => boolean, start = () => async () => {}) {
  const held = {
    entered: createDeferredCore(),
    release: createDeferredCore(),
    finish: createDeferredCore(),
    signal: undefined as AbortSignal | undefined,
    joined: false,
    run: async (signal: AbortSignal | undefined) => {
      if (!accept()) {
        return;
      }
      held.signal = signal;
      const cleanup = start();
      const cancel = () => held.release.resolve();
      signal?.addEventListener("abort", cancel, { once: true });
      held.entered.resolve();
      try {
        await held.release.promise;
        await held.finish.promise;
      } finally {
        signal?.removeEventListener("abort", cancel);
        await cleanup();
        held.joined = true;
      }
    },
  };
  return held;
}

it("joins managed reload acquisition during Gateway close", async () => {
  const fixture = await createGatewayMetadataCloseFixture("managed-model-close");
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
  fixture.config.gateway = { reload: { mode: "hybrid" } };
  fixture.config.agents = {
    defaults: { workspace: fixture.state.workspaceDir, model: `${fixture.pluginId}/before` },
    entries: { main: { workspace: fixture.state.workspaceDir } },
  };
  const reloaderStopEntered = createDeferredCore();
  let armed = false;
  const acquisition = holdAcquisition(() => armed);
  let closeFinished = false;
  let closing: Promise<void> | undefined;
  const missingModelChunk = vi.fn(() => {
    throw Object.assign(new Error("rotated model-runtime chunk"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  });
  let restoreStop = () => {};
  const bridgeKey = await writeCatalog(fixture, acquisition, ["before", "after"]);
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port)!;
    const reloader = kernel.runtimeState.configReloader;
    const stopReloader = reloader.stop.bind(reloader);
    const observedStop = vi.spyOn(reloader, "stop").mockImplementation(() => {
      reloaderStopEntered.resolve();
      return stopReloader();
    });
    restoreStop = () => observedStop.mockRestore();
    const snapshot = await readConfigFileSnapshot();
    armed = true;
    const nextConfig = structuredClone(snapshot.sourceConfig);
    nextConfig.agents!.defaults!.model = `${fixture.pluginId}/after`;
    await fixture.state.writeConfig(nextConfig);
    await acquisition.entered.promise;
    expect(acquisition.signal?.aborted).toBe(false);
    vi.doMock("../agents/prepared-model-runtime.js", missingModelChunk);
    await expect(import("../agents/prepared-model-runtime.js")).rejects.toThrow();
    expect(missingModelChunk).toHaveBeenCalledOnce();
    missingModelChunk.mockClear();
    closing = server.close({ reason: "managed model acquisition fixture" }).finally(() => {
      closeFinished = true;
    });
    void closing.catch(() => {});
    await beforeCompletion(reloaderStopEntered.promise, closing);
    expect(acquisition.signal?.aborted).toBe(true);
    expect(() => refreshPreparedModelRuntimeSnapshots(snapshot.sourceConfig)).toThrow(/shutdown/);
    expect([acquisition.joined, closeFinished]).toEqual([false, false]);
    acquisition.release.resolve();
    acquisition.finish.resolve();
    await closing;
    expect(acquisition.joined).toBe(true);
    expect(missingModelChunk).not.toHaveBeenCalled();
    armed = false;
  } finally {
    armed = false;
    acquisition.release.resolve();
    acquisition.finish.resolve();
    await Promise.allSettled([closing]);
    vi.doUnmock("../agents/prepared-model-runtime.js");
    await fixture.cleanup().finally(() => {
      restoreStop();
      Reflect.deleteProperty(globalThis, bridgeKey);
    });
  }
});

vi.mock("../audit/audit-event-writer.js", async (importOriginal) => {
  const { createAuditEventWriter } =
    await importOriginal<typeof import("../audit/audit-event-writer.js")>();
  return {
    createAuditEventWriter: (...args: Parameters<typeof createAuditEventWriter>) => {
      const writer = createAuditEventWriter(...args);
      const gate = auditMaintenance.gate;
      return gate
        ? {
            ...writer,
            ready: writer.ready.then(() => {
              gate.entered();
              return gate.release;
            }),
          }
        : writer;
    },
  };
});

it.each(["static catalog", "synthetic auth"] as const)(
  "Gateway shutdown joins degraded %s acquisition and registered plugin cleanup outcomes",
  async (phase) => {
    const fixture = await createGatewayMetadataCloseFixture("degraded-model-close");
    const closingEntered = createDeferredCore();
    const cleanupEntered = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const cleanupFailure =
      phase === "synthetic auth" ? new Error("registered acquisition cleanup failed") : undefined;
    let cleanupFinished = false;
    let closeFinished = false;
    const workers: Worker[] = [];
    const timers = new Set<ReturnType<typeof setInterval>>();
    let acquisitions = 0;
    let completePublications = 0;
    const acquisition = holdAcquisition(
      () => ++acquisitions === 2,
      () => {
        const worker = new Worker("setInterval(() => {}, 1000)", { eval: true });
        workers.push(worker);
        const timer = setInterval(() => {}, 1000);
        timers.add(timer);
        return async () => {
          clearInterval(timer);
          timers.delete(timer);
          await worker.terminate();
        };
      },
    );
    const bridgeKey = await writeCatalog(fixture, acquisition, ["model"], phase);
    fixture.config.agents = {
      ownership: "explicit",
      defaults: {
        workspace: fixture.state.workspaceDir,
        model: `${fixture.pluginId}/model`,
        heartbeat: { agentId: "main" },
        systemAgent: { agentId: "main" },
      },
      entries: {
        main: { workspace: fixture.state.workspaceDir },
        late: { workspace: fixture.state.path("late-workspace") },
      },
    };
    fixture.config.talk = { agentId: "main" };
    const unsubscribe = registerPreparedModelRuntimePublicationListener(({ phase: event }) => {
      if (event === "published" && getPreparedModelRuntimeStartupStatus()?.degraded === false) {
        completePublications++;
      }
    });
    const unregisterClose = registerPreparedModelRuntimeClose(async () => {
      closingEntered.resolve();
    });
    let closing: Promise<void> | undefined;
    let publication: Promise<void> | undefined;
    const logFile = fixture.state.path("shutdown.log");
    setLoggerOverride({ file: logFile, level: "debug", consoleLevel: "silent" });
    try {
      const port = await fixture.reservePort();
      const server = await fixture.start(port);
      const callback = fixture.loadCallback(
        fixture.kernels.get(port)!.getPluginMetadataSnapshot()!,
      );
      const lifecycle = getPluginValueInstance(callback)!.lifecycle;
      lifecycle.onDispose(async () => {
        cleanupEntered.resolve();
        expect(acquisition.joined).toBe(true);
        await finishCleanup.promise;
        cleanupFinished = true;
        if (cleanupFailure) {
          throw cleanupFailure;
        }
      });
      expect(process.listenerCount(fixture.event)).toBe(fixture.listeners + 1);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const scheduledTimeouts = vi.spyOn(globalThis, "setTimeout");
      const clearedTimeouts = vi.spyOn(globalThis, "clearTimeout");
      publication = publishConfiguredModelRuntimeSnapshots({ cfg: fixture.config });
      await beforeCompletion(acquisition.entered.promise, publication);
      await vi.advanceTimersByTimeAsync(120_000);
      await publication;
      expect(getPreparedModelRuntimeStartupStatus()).toMatchObject({
        degraded: true,
        pendingAgents: ["late"],
      });
      const acquisitionTimeouts = scheduledTimeouts.mock.results.filter(
        (_result, index) => scheduledTimeouts.mock.calls[index]?.[1] === 120_000,
      );
      expect(acquisitionTimeouts.length).toBeGreaterThan(0);
      for (const timeout of acquisitionTimeouts) {
        expect(clearedTimeouts).toHaveBeenCalledWith(timeout.value);
      }
      scheduledTimeouts.mockRestore();
      clearedTimeouts.mockRestore();
      vi.useRealTimers();
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
      const startedAt = performance.now();
      closing = server.close({ reason: "degraded acquisition fixture" }).finally(() => {
        closeFinished = true;
      });
      void closing.catch(() => {});
      await closingEntered.promise;
      await nextTurn();
      expect(acquisition.signal?.aborted).toBe(true);
      expect([acquisition.joined, closeFinished]).toEqual([false, false]);
      expect(lifecycle.signal.aborted).toBe(false);
      acquisition.finish.resolve();
      await beforeCompletion(cleanupEntered.promise, closing);
      await nextTurn();
      expect(lifecycle.signal.aborted).toBe(true);
      expect([cleanupFinished, closeFinished]).toEqual([false, false]);
      finishCleanup.resolve();
      await closing;
      if (cleanupFailure) {
        await flushLogger();
        expect(await fs.readFile(logFile, "utf8")).toContain(
          `Plugin ${fixture.pluginId} cleanup failed (instance): ${cleanupFailure.message}`,
        );
      }
      expect(cleanupFinished).toBe(true);
      expect(process.listenerCount(fixture.event)).toBe(fixture.listeners);
      expect(() => callback()).toThrow(/retir|disabled|reloaded/);
      expect(performance.now() - startedAt).toBeLessThan(GATEWAY_SHUTDOWN_TIMEOUT_MS);
      expect(acquisition.joined).toBe(true);
      expect(timers.size).toBe(0);
      expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
      expect(getEventListeners(acquisition.signal!, "abort")).toHaveLength(0);
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        workers: 0,
        activeTasks: 0,
        pendingTasks: 0,
      });
      expect(completePublications).toBe(0);
      expect(getPreparedModelRuntimeStartupStatus()?.degraded).not.toBe(false);
      await expect(fetch(`http://127.0.0.1:${port}/readyz`)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
      acquisition.release.resolve();
      acquisition.finish.resolve();
      finishCleanup.resolve();
      await Promise.allSettled([publication, closing]);
      await Promise.all(
        workers.filter((worker) => worker.threadId !== -1).map((worker) => worker.terminate()),
      );
      for (const timer of timers) {
        clearInterval(timer);
      }
      unregisterClose();
      unsubscribe();
      await fixture.cleanup().finally(() => setLoggerOverride(null));
      Reflect.deleteProperty(globalThis, bridgeKey);
    }
  },
);

it("joins initial audit maintenance before metadata fixture callers replace timers", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const gatewayReady = createDeferredCore();
  auditMaintenance.gate = { entered: () => entered.resolve(), release: release.promise };
  const fixture = await createGatewayMetadataCloseFixture("audit-ready-before-clock");
  const serverModule = await import("./server-start.js");
  const start = serverModule.startGatewayServerCore;
  const nativeStartup = vi
    .spyOn(serverModule, "startGatewayServerCore")
    .mockImplementation(async (...args) => {
      const server = await start(...args);
      await server.startupSettled;
      gatewayReady.resolve();
      return server;
    });
  let starting: ReturnType<typeof fixture.start> | undefined;
  let returned = false;
  try {
    const port = await fixture.reservePort();
    starting = fixture.start(port).then((server) => {
      returned = true;
      return server;
    });
    await beforeCompletion(Promise.all([entered.promise, gatewayReady.promise]), starting);
    await nextTurn();
    expect(returned).toBe(false);
    release.resolve();
    await starting;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    release.resolve();
    await Promise.allSettled([starting]);
    auditMaintenance.gate = undefined;
    nativeStartup.mockRestore();
    await fixture.cleanup();
  }
});
