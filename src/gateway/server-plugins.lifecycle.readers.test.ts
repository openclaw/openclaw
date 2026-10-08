import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as cleanupTimeout from "../plugins/host-hook-cleanup-timeout.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as settlement from "../shared/settle-within.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { clearInstanceBindingProbeCoordinators } from "./server-plugins.lifecycle.test-fixtures.js";
import {
  installInstanceBindingConfigIo,
  prepareInstanceBindingFixture,
} from "./server-plugins.lifecycle.test-support.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

// Automatic metadata repair owns the same lease as this fixture's manual reload.
vi.mock("./server-runtime-services.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-runtime-services.js")>()),
  scheduleGatewayPostReadyMaintenance: () => {},
}));

vi.doUnmock("../plugins/loader.js");
installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
installInstanceBindingConfigIo();

it("serves active model and chat metadata throughout an admitted plugin call drain", async (ctx) => {
  const { signal } = ctx;
  const fixture = await prepareInstanceBindingFixture(tempDirs.make("openclaw-drain-readers-"));
  const entered = createDeferredCore();
  const release = createDeferredCore();
  fixture.coordinator.heldCall = { entered: entered.resolve, completion: release.promise };
  const config = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
  config.agents = {
    defaults: {
      model: { primary: "openai/gpt-reader-fixture" },
      models: { "openai/gpt-reader-fixture": {} },
    },
    entries: { main: {} },
  };
  config.models = {
    providers: {
      openai: {
        baseUrl: "https://openai.example.com/v1",
        models: [{ id: "gpt-reader-fixture", name: "Reader fixture" }],
      },
    },
  };
  await fs.writeFile(fixture.configPath, JSON.stringify(config));
  const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const server = await startTestGatewayServer(claim, {
    auth: { mode: "none" },
    controlUiEnabled: false,
    sidecarStartup: "start",
  });
  let socket: Awaited<ReturnType<typeof connectWebchatClient>> | undefined;
  let held: ReturnType<typeof rpcReq> | undefined;
  let reloading: ReturnType<typeof rpcReq> | undefined;
  const drainObservations: Array<{ mockRestore: () => void }> = [];
  const deadline = createDeferredCore<false>();
  const deadlineScope = new AsyncLocalStorage<boolean>();
  let deadlineObservations = 0;
  try {
    await server.startupSettled;
    socket = await connectWebchatClient({ port: claim.port, scopes: ["operator.admin"] });
    const connected = socket;
    const reads = async () =>
      await Promise.all(
        ["models.list", "chat.metadata"].map(async (method) => {
          const start = performance.now();
          const response = await rpcReq(connected, method, { agentId: "main" }, 120_000);
          expect(response.ok, `${method}: ${JSON.stringify(response)}`).toBe(true);
          return { method, durationMs: performance.now() - start, payload: response.payload };
        }),
      );
    const before = await reads();
    const registry = getActivePluginRegistry();
    const record = registry?.plugins.find((plugin) => plugin.id === "instance-binding-probe");
    assert(record);
    const instance = getPluginInstance(record);
    assert(instance);
    const draining = createDeferredCore();
    const wait = instance.waitForRetainedWork.bind(instance);
    drainObservations.push(
      vi.spyOn(instance, "waitForRetainedWork").mockImplementation((...args) => {
        const pending = wait(...args);
        draining.resolve();
        return pending;
      }),
    );
    const drain = instance.drain.bind(instance);
    drainObservations.push(
      vi.spyOn(instance, "drain").mockImplementation((...args) => {
        const pending = drain(...args);
        draining.resolve();
        return pending;
      }),
    );
    // Expire only this drain observation; native Gateway owners keep their clocks.
    const within = settlement.settlesWithin;
    const withCleanupDeadline = cleanupTimeout.withPluginHostCleanupTimeout;
    drainObservations.push(
      vi.spyOn(settlement, "settlesWithin").mockImplementation((pending, timeoutMs) => {
        if (!deadlineScope.getStore()) {
          return within(pending, timeoutMs);
        }
        deadlineObservations += 1;
        expect(timeoutMs).toBeGreaterThan(0);
        expect(timeoutMs).toBeLessThanOrEqual(60_000);
        return Promise.race([pending.then(() => true), deadline.promise]);
      }),
      vi
        .spyOn(cleanupTimeout, "withPluginHostCleanupTimeout")
        .mockImplementation(
          <T>(label: string, cleanup: () => T | Promise<T>, timeoutMs?: number) =>
            label === "retained plugin work"
              ? deadlineScope.run(true, () => withCleanupDeadline(label, cleanup, timeoutMs))
              : withCleanupDeadline(label, cleanup, timeoutMs),
        ),
    );
    held = rpcReq(connected, "instanceBinding.hold", {}, 120_000);
    await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        held.then((result) => {
          expect(result.ok, JSON.stringify(result)).toBe(true);
        }),
        "held plugin call settled before entering its handler",
      ),
      signal,
    );
    let reloadSettled = false;
    reloading = rpcReq(
      connected,
      "plugins.reload",
      { plugins: [{ pluginId: "instance-binding-probe" }] },
      120_000,
    ).then((result) => {
      reloadSettled = true;
      return result;
    });
    await withinTest(
      awaitGateBeforeSettlement(
        draining.promise,
        reloading.then((result) => {
          throw new Error(
            `plugins.reload settled before entering drain: ${JSON.stringify(result)}`,
          );
        }),
        "plugin reload settled before entering drain",
      ),
      signal,
    );
    expect(instance.acceptingCalls).toBe(false);
    const during = await withinTest(reads(), signal);
    expect(reloadSettled).toBe(false);
    expect(getActivePluginRegistry()).toBe(registry);
    expect(during.map((entry) => entry.payload)).toEqual(before.map((entry) => entry.payload));
    expect(deadlineObservations).toBe(1);
    deadline.resolve(false);
    expect(await reloading).toMatchObject({
      ok: false,
      error: { details: { runtime: { committed: false, phase: "drain" } } },
    });
    expect(getActivePluginRegistry()).toBe(registry);
    expect(instance.acceptingCalls).toBe(true);
    const after = await reads();
    expect(after.map((entry) => entry.payload)).toEqual(before.map((entry) => entry.payload));
    console.info(
      "PLUGIN_DRAIN_READER_LATENCY " +
        JSON.stringify({
          before: before.map(({ method, durationMs }) => ({ method, durationMs })),
          during: during.map(({ method, durationMs }) => ({ method, durationMs })),
          after: after.map(({ method, durationMs }) => ({ method, durationMs })),
        }),
    );
    release.resolve();
    expect((await held).ok).toBe(true);
  } finally {
    deadline.resolve(false);
    release.resolve();
    await Promise.allSettled([held, reloading]);
    for (const observation of drainObservations) {
      observation.mockRestore();
    }
    socket?.close();
    await server.close({ reason: "plugin drain reader fixture complete" });
    clearInstanceBindingProbeCoordinators();
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  }
}, 60_000);
