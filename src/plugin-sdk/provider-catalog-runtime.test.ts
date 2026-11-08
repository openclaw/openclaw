import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import {
  augmentModelCatalogWithProviderPlugins as augmentCatalog,
  resolvePluginProviders as resolveProviders,
} from "openclaw/plugin-sdk/provider-catalog-runtime";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  createScheduledGatewayRunner as scheduledRunner,
  fenceScheduledGatewayContextResolver as fenceResolver,
} from "../gateway/scheduled-run-gateway-context.js";
import { createPluginRuntimeCapabilityLease } from "../plugins/capability-lease.js";
import {
  LegacyPluginSdkResourceHost,
  bindLegacyPluginSdkResourceHost as bindSdkHost,
} from "../plugins/legacy-sdk-resource-host.js";
import { acquirePluginRegistryForInspection, loadPluginRegistryHandle } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope as requestScope,
  getSharedGatewayContextResolver as sharedResolver,
  withPluginRuntimeGatewayRequestScope as withRequest,
  withPluginRuntimeRegistryScope as withRegistry,
} from "../plugins/runtime/gateway-request-scope.js";
import { createPluginServiceSchedulerRunner } from "../plugins/service-scheduler-context.js";
import { createPluginServiceScheduler } from "../plugins/service-scheduler.js";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  trackAsyncWork,
} from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

let sequence = 0;

function resolverContext(resolver: Parameters<typeof bindGatewayContextResolver>[1]) {
  const context = {};
  bindGatewayContextResolver(context, resolver);
  return context;
}

function pluginContext(id: string, plugin: ReturnType<typeof writePlugin>, providers: string[]) {
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      providers,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  return {
    config: { plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } } },
    env: {
      HOME: plugin.dir,
      OPENCLAW_STATE_DIR: plugin.dir + "/state",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  };
}

it("shipped catalog augmentation selects omitted hooks without filtering their rows", async () => {
  const id = `sdk-catalog-selection-${sequence++}`;
  const stateKey = `__${id}`;
  const plugin = writePlugin({
    id,
    body: `module.exports = { id: ${JSON.stringify(id)}, register(api) {
        api.registerProvider({ id: "sdk-family", label: "Family", auth: [],
          aliases: ["sdk-alias"], hookAliases: ["sdk-family-east"],
          augmentModelCatalog: () => {
            globalThis[${JSON.stringify(stateKey)}].push("sdk-family");
            return [{ provider: "foreign", id: "family", name: "Family row" }];
          },
        });
        api.registerProvider({ id: "sdk-other", label: "Other", auth: [],
          augmentModelCatalog: () => {
            globalThis[${JSON.stringify(stateKey)}].push("sdk-other");
            return [{ provider: "foreign", id: "other", name: "Other row" }];
          },
        });
      } };`,
  });
  const { config, env } = pluginContext(id, plugin, ["sdk-family", "sdk-other"]);
  const calls: string[] = [];
  Object.defineProperty(globalThis, stateKey, { configurable: true, value: calls });
  try {
    const rows = await augmentCatalog({
      config,
      env,
      context: { config, env, entries: [{ provider: "input", id: "seed", name: "Input seed" }] },
    });
    expect(calls).toEqual(["sdk-family", "sdk-other"]);
    expect(rows.map((row) => row.id)).toEqual(["family", "other"]);
    expect(rows.map((row) => row.provider)).toEqual(["foreign", "foreign"]);
  } finally {
    Reflect.deleteProperty(globalThis, stateKey);
  }
});

async function nativeProviderFixture(
  disposalFailure = false,
  captureDisposal: false | "tracker" | "binding" = false,
  raw = false,
) {
  const id = `sdk-inspection-provider-${sequence++}`;
  const stateKey = `__${id}`;
  const state = {
    database: undefined as DatabaseSync | undefined,
    disposals: 0,
    pauseDisposal: false,
    disposalEntered: createDeferredCore(),
    resumeDisposal: createDeferredCore(),
    captureCleanup: () =>
      captureDisposal === "binding"
        ? AsyncLocalStorage.bind(trackAsyncWork)
        : captureAsyncWorkTracker(),
  };
  Object.defineProperty(globalThis, stateKey, { configurable: true, value: state });
  const plugin = writePlugin({
    id,
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  const state = globalThis[${JSON.stringify(stateKey)}];
  const database = state.database = new DatabaseSync(":memory:");
  const runCleanup = ${captureDisposal !== false} ? state.captureCleanup() : (run) => run();
  api.registerRuntimeLifecycle({ id: "native", dispose: () => runCleanup(async () => {
    state.disposals++;
    state.disposalEntered.resolve();
    if (state.pauseDisposal) await state.resumeDisposal.promise;
    database.close();
    if (${disposalFailure}) throw new Error("synthetic SDK disposal failure");
  }) });
  api.registerProvider({ id: ${JSON.stringify(id)}, label: "SDK inspection provider", auth: [],
    isCacheTtlEligible: () => database.prepare("SELECT 42 AS value").get().value === 42,
  });
} };`,
  });
  const { config, env } = pluginContext(id, plugin, [id]);
  const hosts = [new LegacyPluginSdkResourceHost()];
  const inspection = raw ? undefined : await acquirePluginRegistryForInspection({ config, env });
  const registry = inspection?.registry ?? loadPluginRegistryHandle({ config, env });
  const release = () => inspection?.release() ?? Promise.resolve();
  const cleanup = async () => {
    state.resumeDisposal.resolve();
    await Promise.allSettled([...hosts.map((host) => host.close()), release()]);
    if (state.database?.isOpen) {
      state.database.close();
    }
    Reflect.deleteProperty(globalThis, stateKey);
  };
  return {
    id,
    state,
    config,
    env,
    registry,
    release,
    cleanup,
    host: hosts[0]!,
    [Symbol.asyncDispose]: cleanup,
    makeHost() {
      const host = new LegacyPluginSdkResourceHost();
      hosts.push(host);
      return host;
    },
    getter(key: string, get: () => unknown) {
      Object.defineProperty(registry.providers[0]!.provider, key, {
        enumerable: true,
        configurable: key === "aliases",
        get,
      });
    },
    expectState(disposals: number, isOpen: boolean) {
      expect(state).toMatchObject({ disposals, database: { isOpen } });
    },
    resolve(host = hosts[0]!, providerRefs?: string[]) {
      return host.run(() =>
        withRegistry(registry, () =>
          resolveProviders({ config, env, onlyPluginIds: [id], providerRefs }),
        ),
      );
    },
  };
}

function readProvider(provider: ReturnType<typeof resolveProviders>[number]): boolean | undefined {
  return provider.isCacheTtlEligible?.({ provider: provider.id, modelId: "synthetic-model" });
}

it.each([false, true])("scheduled CLI owns bare resources, ambient RPC=%s", async (ambientRpc) => {
  await using fixture = await nativeProviderFixture();
  const clock = createGatewaySchedulerClock();
  const gateway = createTestGatewayScheduler(clock.clock);
  const host = fixture.host;
  const foreign = fixture.makeHost();
  host.bindScheduler(gateway);
  const lease = createPluginRuntimeCapabilityLease("scheduled CLI fixture");
  const record = fixture.registry.plugins.find((entry) => entry.id === fixture.id);
  if (!record) {
    throw new Error("Fixture provider did not register");
  }
  const createScheduler = () =>
    createPluginServiceScheduler(
      gateway,
      createPluginServiceSchedulerRunner({
        registry: fixture.registry,
        record,
        instance: getPluginInstance(record),
        lease,
      }),
    ).scheduler;
  const foreignResolver = () => undefined;
  bindSdkHost(foreignResolver, foreign);
  const scheduler = host.run(() =>
    ambientRpc
      ? withRequest(
          { resolveGatewayContext: foreignResolver, isWebchatConnect: () => false },
          createScheduler,
        )
      : createScheduler(),
  );
  let providers: ReturnType<typeof resolveProviders> = [];
  scheduler.schedule({
    id: "provider-borrow",
    delayMs: 1,
    run: () => {
      providers = resolveProviders({
        config: fixture.config,
        env: fixture.env,
        onlyPluginIds: [fixture.id],
      });
    },
  });
  try {
    await foreign.run(() => clock.advanceBy(1));
    expect(providers).toHaveLength(1);
    await fixture.release();
    await foreign.close();
    expect(readProvider(providers[0]!)).toBe(true);
    expect(fixture.state.disposals).toBe(0);
    await scheduler.stop();
    await host.close();
    fixture.expectState(1, false);
  } finally {
    await scheduler.stop();
    lease.revoke();
    await Promise.allSettled([fixture.cleanup(), gateway.stop()]);
  }
});

it("keeps two SDK hosts independent while borrowing the same native source", async () => {
  await using fixture = await nativeProviderFixture();
  const first = fixture.host;
  const second = fixture.makeHost();

  const [firstProvider] = fixture.resolve(first);
  const [secondProvider] = fixture.resolve(second);
  await fixture.release();
  expect(readProvider(firstProvider!)).toBe(true);
  await first.close();
  expect(readProvider(secondProvider!)).toBe(true);
  expect(fixture.state.disposals).toBe(0);
  await second.close();
  fixture.expectState(1, false);
});

it("does not dispose a raw registry selected through the public facade", async () => {
  await using fixture = await nativeProviderFixture(false, false, true);
  const host = fixture.host;
  const [provider] = fixture.resolve(host);
  await host.close();
  expect(readProvider(provider!)).toBe(true);
  expect(fixture.state.disposals).toBe(0);
});

it("does not revive an inspection released by an earlier selection getter", async () => {
  await using fixture = await nativeProviderFixture();
  const host = fixture.host;
  let released: Promise<void> | undefined;
  let reads = 0;
  fixture.getter("aliases", () => {
    reads++;
    released = fixture.release();
    return ["synthetic-runtime-alias"];
  });

  expect(() => fixture.resolve(host, ["synthetic-runtime-alias"])).toThrow("reloaded or disabled");
  expect(reads).toBeGreaterThan(0);
  await released;
  expect(fixture.state.disposals).toBe(1);
});

it.each([
  { name: "first projection", previouslyAdopted: false, tail: false },
  { name: "adopted view", previouslyAdopted: true, tail: false },
  { name: "tracked tail", previouslyAdopted: false, tail: true },
])("failed $name projection waits for owned work", async ({ previouslyAdopted, tail }) => {
  await using fixture = await nativeProviderFixture();
  const host = fixture.host;
  const previous = previouslyAdopted ? fixture.resolve(host)[0] : undefined;
  const failure = new Error("synthetic provider projection failure");
  const finishTail = createDeferredCore();
  let tailWork: Promise<void> | undefined;
  fixture.getter("sdkProjection", () => {
    if (tail) {
      tailWork = trackAsyncWork(async () => {
        await finishTail.promise;
        const provider = fixture.registry.providers[0]!.provider;
        expect(
          provider.isCacheTtlEligible?.({ provider: provider.id, modelId: "synthetic-model" }),
        ).toBe(true);
      });
    }
    throw failure;
  });
  try {
    expect(() => fixture.resolve(host)).toThrow(failure);
    await fixture.release();
    fixture.expectState(previouslyAdopted || tail ? 0 : 1, previouslyAdopted || tail);
    if (previous) {
      expect(readProvider(previous)).toBe(true);
    }
    let closed = false;
    const closing = host.close().then(() => {
      closed = true;
    });
    if (tail) {
      await waitForImmediate();
      expect(closed).toBe(false);
      finishTail.resolve();
      await tailWork;
    }
    await closing;
    fixture.expectState(1, false);
  } finally {
    finishTail.resolve();
    await Promise.allSettled([tailWork, fixture.cleanup()]);
  }
});

it.each([false, true])(
  "projection joins closing host, disposal fails=%s",
  async (disposalFailure) => {
    await using fixture = await nativeProviderFixture(disposalFailure);
    const host = fixture.host;
    fixture.state.pauseDisposal = true;
    let closing: Promise<void> | undefined;
    let closed = false;
    fixture.getter("sdkProjection", () => {
      void fixture.release();
      closing = host.close();
      void closing
        .finally(() => {
          closed = true;
        })
        .catch(() => undefined);
      return "synthetic";
    });

    expect(() => fixture.resolve(host)).toThrow("SDK resource host is closed");
    await fixture.state.disposalEntered.promise;
    expect(closed).toBe(false);
    expect(fixture.state.database?.isOpen).toBe(true);
    fixture.state.resumeDisposal.resolve();
    if (disposalFailure) {
      await expect(closing).rejects.toThrow("SDK resources could not all be disposed");
    } else {
      await closing;
    }
    expect(host.close()).toBe(closing);
    fixture.expectState(1, false);
  },
);

it("retains context-only Gateway provider resources after a foreign ambient host closes", async () => {
  const { withLocalGatewayRequestScope } = await import("../gateway/local-request-context.js");
  const { createOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
  const testState = await createOpenClawTestState({ label: "sdk-context-only-owner" });
  await using fixture = await nativeProviderFixture();
  const owner = fixture.host;
  const foreign = fixture.makeHost();
  try {
    await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
      const context = requestScope()?.context;
      if (!context?.resolveGatewayContext) {
        throw new Error("The local Gateway must provide its complete request context");
      }
      const resolverSpy = vi.spyOn(context, "resolveGatewayContext");
      bindSdkHost(context.resolveGatewayContext, owner);
      try {
        const [provider] = foreign.run(() =>
          withRequest({ context, isWebchatConnect: () => false }, () => fixture.resolve(foreign)),
        );
        await fixture.release();
        await foreign.close();
        expect(readProvider(provider!)).toBe(true);
        expect(fixture.state.disposals).toBe(0);
        await owner.close();
        fixture.expectState(1, false);
        expect(resolverSpy).not.toHaveBeenCalled();
      } finally {
        resolverSpy.mockRestore();
      }
    });
  } finally {
    await fixture.cleanup();
    await testState.cleanup();
  }
});

it.each(["scheduled", "shared-scheduled"] as const)(
  "%s retains exact Gateway host",
  async (kind) => {
    const { withLocalGatewayRequestScope } = await import("../gateway/local-request-context.js");
    await using fixture = await nativeProviderFixture();
    const owner = fixture.host;
    const foreign = fixture.makeHost();
    const canonical = vi.fn(() => {
      throw new Error("SDK host lookup must not invoke an execution resolver");
    });
    bindSdkHost(canonical, owner);
    const scheduled = fenceResolver(canonical);
    const first = resolverContext(scheduled);
    const second = resolverContext(fenceResolver(scheduled));
    const resolver = kind === "scheduled" ? scheduled : sharedResolver([first, second]);
    const runScheduled = scheduledRunner(resolver);
    const resolve = () =>
      foreign.run(() =>
        runScheduled(async () => {
          const existing = requestScope();
          return withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, () => {
            expect(requestScope()).toBe(existing);
            return fixture.resolve(foreign);
          });
        }),
      );

    const [provider] = await resolve();
    expect(readProvider(provider!)).toBe(true);
    await owner.close();
    // The inspection still owns its source; the closed SDK host must not admit another borrow.
    expect(fixture.state.database?.isOpen).toBe(true);
    await expect(resolve()).rejects.toThrow("SDK resource host is closed");
    await fixture.release();
    fixture.expectState(1, false);
    expect(canonical).not.toHaveBeenCalled();
  },
);

it.each(["unknown", "mixed-composite"] as const)(
  "%s owner cannot borrow from ambient host",
  async (kind) => {
    await using fixture = await nativeProviderFixture();
    const foreign = fixture.makeHost();
    const firstHost = fixture.makeHost();
    const secondHost = fixture.makeHost();
    const firstResolver = vi.fn(() => undefined);
    const secondResolver = vi.fn(() => undefined);
    bindSdkHost(firstResolver, firstHost);
    bindSdkHost(secondResolver, secondHost);
    const first = resolverContext(firstResolver);
    const second = resolverContext(secondResolver);
    const unknown = vi.fn(() => undefined);
    const resolver = kind === "unknown" ? unknown : sharedResolver([first, second]);
    const runScheduled = scheduledRunner(resolver);

    await expect(
      foreign.run(() => runScheduled(async () => fixture.resolve(foreign))),
    ).rejects.toThrow("Gateway SDK resource host is not bound");
    await fixture.release();
    fixture.expectState(1, false);
    expect(firstResolver).not.toHaveBeenCalled();
    expect(secondResolver).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled();
  },
);

it.each(["tracker", "binding"] as const)(
  "%s cleanup survives registration owner drain",
  async (capture) => {
    const registrationWork = new AsyncWorkScope();
    await using fixture = await registrationWork.track(() => nativeProviderFixture(false, capture));
    const sdkHost = fixture.host;
    try {
      const [provider] = fixture.resolve(sdkHost);
      await fixture.release();
      await registrationWork.drain();
      expect(readProvider(provider!)).toBe(true);
      await sdkHost.close();
      fixture.expectState(1, false);
    } finally {
      await Promise.allSettled([fixture.cleanup(), registrationWork.drain()]);
    }
  },
);
