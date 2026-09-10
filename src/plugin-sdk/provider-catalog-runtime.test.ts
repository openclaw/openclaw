import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolvePluginProviders } from "openclaw/plugin-sdk/provider-catalog-runtime";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  fenceScheduledGatewayContextResolver,
  runWithScheduledGatewayContext,
} from "../gateway/scheduled-run-gateway-context.js";
import {
  LegacyPluginSdkResourceHost,
  bindLegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import { acquirePluginRegistryForInspection, loadPluginRegistryHandle } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { isPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  getSharedGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  trackAsyncWork,
} from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";

afterEach(() => resetPluginLoaderTestStateForTest());
afterAll(cleanupPluginLoaderFixturesForTest);

it("resolves an empty provider scope through the shipped SDK export", () => {
  expect(
    resolvePluginProviders({
      config: { plugins: { enabled: false } },
      env: {},
      onlyPluginIds: [],
    }),
  ).toEqual([]);
});

let sequence = 0;

function nativeProviderFixture(
  disposalFailure = false,
  captureDisposal: false | "tracker" | "binding" = false,
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
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      providers: [id],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const config = {
    plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
  };
  const env = {
    HOME: plugin.dir,
    OPENCLAW_STATE_DIR: `${plugin.dir}/state`,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  return {
    id,
    state,
    load: () => acquirePluginRegistryForInspection({ config, env }),
    loadRaw: () => loadPluginRegistryHandle({ config, env }),
    resolve(registry: PluginRegistry, host: LegacyPluginSdkResourceHost, providerRefs?: string[]) {
      return host.run(() =>
        withPluginRuntimeRegistryScope(registry, () =>
          resolvePluginProviders({ config, env, onlyPluginIds: [id], providerRefs }),
        ),
      );
    },
    cleanup() {
      state.resumeDisposal.resolve();
      if (state.database?.isOpen) {
        state.database.close();
      }
      Reflect.deleteProperty(globalThis, stateKey);
    },
  };
}

function readProvider(
  provider: ReturnType<typeof resolvePluginProviders>[number],
): boolean | undefined {
  return provider.isCacheTtlEligible?.({ provider: provider.id, modelId: "synthetic-model" });
}

it("keeps the shipped provider callback usable after inspection release", async () => {
  const fixture = nativeProviderFixture();
  const host = new LegacyPluginSdkResourceHost();
  const inspection = await fixture.load();
  try {
    const providers = fixture.resolve(inspection.registry, host);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.id).toBe(fixture.id);
    expect(readProvider(providers[0]!)).toBe(true);
    expect(fixture.resolve(inspection.registry, host)).toHaveLength(1);
    await inspection.release();
    expect(isPluginRegistryRetired(inspection.registry)).toBe(true);
    expect(readProvider(providers[0]!)).toBe(true);
    expect(fixture.state.disposals).toBe(0);
    expect(() => fixture.resolve(inspection.registry, host)).toThrow(
      "inspection resources have been released",
    );
    await host.close();
    expect(fixture.state.disposals).toBe(1);
    expect(fixture.state.database?.isOpen).toBe(false);
  } finally {
    await host.close();
    await inspection.release();
    fixture.cleanup();
  }
});

it("keeps two SDK hosts independent while borrowing the same native source", async () => {
  const fixture = nativeProviderFixture();
  const first = new LegacyPluginSdkResourceHost();
  const second = new LegacyPluginSdkResourceHost();
  const inspection = await fixture.load();
  try {
    const [firstProvider] = fixture.resolve(inspection.registry, first);
    const [secondProvider] = fixture.resolve(inspection.registry, second);
    await inspection.release();
    expect(readProvider(firstProvider!)).toBe(true);
    await first.close();
    expect(readProvider(secondProvider!)).toBe(true);
    expect(fixture.state.disposals).toBe(0);
    await second.close();
    expect(fixture.state.disposals).toBe(1);
    expect(fixture.state.database?.isOpen).toBe(false);
  } finally {
    await Promise.allSettled([first.close(), second.close(), inspection.release()]);
    fixture.cleanup();
  }
});

it("does not dispose a raw registry selected through the public facade", async () => {
  const fixture = nativeProviderFixture();
  const host = new LegacyPluginSdkResourceHost();
  try {
    const registry = fixture.loadRaw();
    const [provider] = fixture.resolve(registry, host);
    await host.close();
    expect(readProvider(provider!)).toBe(true);
    expect(fixture.state.disposals).toBe(0);
  } finally {
    await host.close();
    fixture.cleanup();
  }
});

it("does not revive an inspection released by an earlier selection getter", async () => {
  const fixture = nativeProviderFixture();
  const host = new LegacyPluginSdkResourceHost();
  const inspection = await fixture.load();
  let released: Promise<void> | undefined;
  let reads = 0;
  Object.defineProperty(inspection.registry.providers[0]!.provider, "aliases", {
    configurable: true,
    enumerable: true,
    get() {
      reads++;
      released = inspection.release();
      return ["synthetic-runtime-alias"];
    },
  });
  try {
    expect(() => fixture.resolve(inspection.registry, host, ["synthetic-runtime-alias"])).toThrow(
      "inspection resources have been released",
    );
    expect(reads).toBeGreaterThan(0);
    await released;
    expect(fixture.state.disposals).toBe(1);
  } finally {
    await Promise.allSettled([host.close(), inspection.release()]);
    fixture.cleanup();
  }
});

it("releases its temporary native claim when provider projection throws", async () => {
  const fixture = nativeProviderFixture();
  const host = new LegacyPluginSdkResourceHost();
  const inspection = await fixture.load();
  const failure = new Error("synthetic provider projection failure");
  Object.defineProperty(inspection.registry.providers[0]!.provider, "sdkProjection", {
    enumerable: true,
    get() {
      throw failure;
    },
  });
  try {
    expect(() => fixture.resolve(inspection.registry, host)).toThrow(failure);
    await inspection.release();
    expect(fixture.state.disposals).toBe(1);
    expect(fixture.state.database?.isOpen).toBe(false);
    await host.close();
  } finally {
    await Promise.allSettled([host.close(), inspection.release()]);
    fixture.cleanup();
  }
});

it.each([false, true])(
  "joins a temporary claim when a projection getter closes the exact host (disposal fails: %s)",
  async (disposalFailure) => {
    const fixture = nativeProviderFixture(disposalFailure);
    const host = new LegacyPluginSdkResourceHost();
    const inspection = await fixture.load();
    fixture.state.pauseDisposal = true;
    let closing: Promise<void> | undefined;
    let closed = false;
    Object.defineProperty(inspection.registry.providers[0]!.provider, "sdkProjection", {
      enumerable: true,
      get() {
        void inspection.release();
        closing = host.close();
        void closing.then(
          () => {
            closed = true;
          },
          () => {
            closed = true;
          },
        );
        return "synthetic";
      },
    });
    try {
      expect(() => fixture.resolve(inspection.registry, host)).toThrow(
        "SDK resource host is closed",
      );
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
      expect(fixture.state.database?.isOpen).toBe(false);
      expect(fixture.state.disposals).toBe(1);
    } finally {
      fixture.state.resumeDisposal.resolve();
      await Promise.allSettled([host.close(), inspection.release()]);
      fixture.cleanup();
    }
  },
);

it("retains context-only Gateway provider resources after a foreign ambient host closes", async () => {
  const { withLocalGatewayRequestScope } = await import("../gateway/local-request-context.js");
  const { createOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
  const testState = await createOpenClawTestState({ label: "sdk-context-only-owner" });
  const fixture = nativeProviderFixture();
  const owner = new LegacyPluginSdkResourceHost();
  const foreign = new LegacyPluginSdkResourceHost();
  const inspection = await fixture.load();
  try {
    await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
      const context = getPluginRuntimeGatewayRequestScope()?.context;
      if (!context?.resolveGatewayContext) {
        throw new Error("The local Gateway must provide its complete request context");
      }
      const resolverSpy = vi.spyOn(context, "resolveGatewayContext");
      bindLegacyPluginSdkResourceHost(context.resolveGatewayContext, owner);
      try {
        const [provider] = foreign.run(() =>
          withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
            fixture.resolve(inspection.registry, foreign),
          ),
        );
        await inspection.release();
        await foreign.close();
        expect(readProvider(provider!)).toBe(true);
        expect(fixture.state.disposals).toBe(0);
        await owner.close();
        expect(fixture.state.database?.isOpen).toBe(false);
        expect(fixture.state.disposals).toBe(1);
        expect(resolverSpy).not.toHaveBeenCalled();
      } finally {
        resolverSpy.mockRestore();
      }
    });
  } finally {
    await Promise.allSettled([owner.close(), foreign.close(), inspection.release()]);
    fixture.cleanup();
    await testState.cleanup();
  }
});

it.each(["scheduled", "shared-scheduled"] as const)(
  "retains the exact %s Gateway SDK host under a foreign ambient host",
  async (kind) => {
    const { withLocalGatewayRequestScope } = await import("../gateway/local-request-context.js");
    const fixture = nativeProviderFixture();
    const owner = new LegacyPluginSdkResourceHost();
    const foreign = new LegacyPluginSdkResourceHost();
    const canonical = vi.fn(() => {
      throw new Error("SDK host lookup must not invoke an execution resolver");
    });
    bindLegacyPluginSdkResourceHost(canonical, owner);
    const scheduled = fenceScheduledGatewayContextResolver(canonical);
    const first = {};
    const second = {};
    bindGatewayContextResolver(first, scheduled);
    bindGatewayContextResolver(second, fenceScheduledGatewayContextResolver(scheduled));
    const resolver =
      kind === "scheduled" ? scheduled : getSharedGatewayContextResolver([first, second]);
    const inspection = await fixture.load();
    const resolve = () =>
      foreign.run(() =>
        runWithScheduledGatewayContext({
          resolveGatewayContext: resolver,
          run: async () => {
            const existing = getPluginRuntimeGatewayRequestScope();
            return withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, () => {
              expect(getPluginRuntimeGatewayRequestScope()).toBe(existing);
              return fixture.resolve(inspection.registry, foreign);
            });
          },
        }),
      );
    try {
      const [provider] = await resolve();
      expect(readProvider(provider!)).toBe(true);
      await owner.close();
      // The inspection still owns its source; the closed SDK host must not admit another borrow.
      expect(fixture.state.database?.isOpen).toBe(true);
      await expect(resolve()).rejects.toThrow("SDK resource host is closed");
      await inspection.release();
      expect(fixture.state.database?.isOpen).toBe(false);
      expect(fixture.state.disposals).toBe(1);
      expect(canonical).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled([owner.close(), foreign.close(), inspection.release()]);
      fixture.cleanup();
    }
  },
);

it.each(["unknown", "mixed-composite"] as const)(
  "refuses a managed SDK borrow from an %s Gateway owner without ambient fallback",
  async (kind) => {
    const fixture = nativeProviderFixture();
    const foreign = new LegacyPluginSdkResourceHost();
    const firstHost = new LegacyPluginSdkResourceHost();
    const secondHost = new LegacyPluginSdkResourceHost();
    const firstResolver = vi.fn(() => undefined);
    const secondResolver = vi.fn(() => undefined);
    const first = {};
    const second = {};
    bindLegacyPluginSdkResourceHost(firstResolver, firstHost);
    bindLegacyPluginSdkResourceHost(secondResolver, secondHost);
    bindGatewayContextResolver(first, firstResolver);
    bindGatewayContextResolver(second, secondResolver);
    const unknown = vi.fn(() => undefined);
    const resolver =
      kind === "unknown" ? unknown : getSharedGatewayContextResolver([first, second]);
    const inspection = await fixture.load();
    try {
      await expect(
        foreign.run(() =>
          runWithScheduledGatewayContext({
            resolveGatewayContext: resolver,
            run: async () => fixture.resolve(inspection.registry, foreign),
          }),
        ),
      ).rejects.toThrow("Gateway SDK resource host is not bound");
      await inspection.release();
      expect(fixture.state.database?.isOpen).toBe(false);
      expect(fixture.state.disposals).toBe(1);
      expect(firstResolver).not.toHaveBeenCalled();
      expect(secondResolver).not.toHaveBeenCalled();
      expect(unknown).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled([
        foreign.close(),
        firstHost.close(),
        secondHost.close(),
        inspection.release(),
      ]);
      fixture.cleanup();
    }
  },
);

it.each(["tracker", "binding"] as const)(
  "keeps registration cleanup captured by %s usable after its initiating work owner drains",
  async (capture) => {
    const fixture = nativeProviderFixture(false, capture);
    const registrationWork = new AsyncWorkScope();
    const sdkHost = new LegacyPluginSdkResourceHost();
    const inspection = await registrationWork.track(fixture.load);
    try {
      const [provider] = fixture.resolve(inspection.registry, sdkHost);
      await inspection.release();
      await registrationWork.drain();
      expect(readProvider(provider!)).toBe(true);
      await sdkHost.close();
      expect(fixture.state.disposals).toBe(1);
      expect(fixture.state.database?.isOpen).toBe(false);
    } finally {
      await Promise.allSettled([sdkHost.close(), inspection.release(), registrationWork.drain()]);
      fixture.cleanup();
    }
  },
);
