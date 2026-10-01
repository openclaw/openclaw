import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
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

vi.doUnmock("../plugins/loader.js");
installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
installInstanceBindingConfigIo();

it("serves active model and chat metadata throughout an admitted plugin call drain", async () => {
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
    entries: { main: { default: true } },
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
    held = rpcReq(connected, "instanceBinding.hold", {}, 120_000);
    await entered.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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
    await draining.promise;
    expect(instance.acceptingCalls).toBe(false);
    const during = await reads();
    expect(reloadSettled).toBe(false);
    expect(getActivePluginRegistry()).toBe(registry);
    expect(during.map((entry) => entry.payload)).toEqual(before.map((entry) => entry.payload));
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    expect(await reloading).toMatchObject({
      ok: false,
      error: { details: { runtime: { committed: false, phase: "drain" } } },
    });
    expect(getActivePluginRegistry()).toBe(registry);
    const after = await reads();
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
    vi.useRealTimers();
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
