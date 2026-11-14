import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { captureSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker-context.js";
import {
  createSqliteReadOnlyWorkerScope,
  runScopedSqliteInspection,
} from "../infra/sqlite-readonly-worker.js";
import { createDeferredCore } from "../shared/deferred.js";
import { buildPluginApi, createUnavailableRuntime } from "./api-builder.js";
import { instrumentPluginInstanceApi } from "./api-facades.js";
import {
  LegacyPluginSdkResourceHost,
  getBoundLegacyPluginSdkResourceHost,
} from "./legacy-sdk-resource-host.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { createOwnedInstance, throwing, trackCompletion } from "./plugin-instance.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { adoptPluginRegistryRecords } from "./registry-lifecycle.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";

function fixture() {
  const { registry, record, instance } = createOwnedInstance("background-owner");
  const api = instrumentPluginInstanceApi(
    buildPluginApi({
      ...record,
      registrationMode: "full",
      config: {},
      runtime: createUnavailableRuntime("setup-only"),
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
    }),
    instance,
  );
  return { registry, record, instance, run: api.lifecycle.runInBackgroundContext! };
}

it.each([false, true])(
  "owns readers when registration closes before background work settles (alreadyClosed=%s)",
  async (alreadyClosed) => {
    const registration = createSqliteReadOnlyWorkerScope();
    const owner = registration.run(fixture);
    const caller = createSqliteReadOnlyWorkerScope();
    const release = createDeferredCore();
    let readers: ReturnType<typeof captureSqliteReadOnlyWorkerScope> | undefined;
    let pending: Promise<string> | undefined;
    try {
      if (alreadyClosed) {
        await registration.close();
      }
      pending = caller.run(() =>
        owner.run(async () => {
          readers = captureSqliteReadOnlyWorkerScope();
          await release.promise;
          return runScopedSqliteInspection(undefined, async (signal) => {
            signal?.throwIfAborted();
            return "background read completed";
          });
        }),
      );
      await registration.close();
      await caller.close();
      release.resolve();
      await expect(pending).resolves.toBe("background read completed");
      expect(readers?.(() => "live")).toBe("live");
      owner.instance.onModuleDispose(() => {
        expect(readers?.(() => "module cleanup")).toBe("module cleanup");
      });
      await expect(owner.instance.dispose()).resolves.toEqual({ errors: [] });
      expect(() => readers?.(() => "retired")).toThrow("SQLite read-only worker scope closed");
    } finally {
      release.resolve();
      await Promise.allSettled([pending, registration.close(), caller.close()]);
      await owner.instance.dispose();
    }
  },
);

it("detaches registration and opening requests, follows adoption, and preserves its host", async () => {
  const caller = new AsyncLocalStorage<string>();
  const host = new LegacyPluginSdkResourceHost();
  const owner = host.run(() => caller.run("registration", fixture));
  const successor = createEmptyPluginRegistry();
  successor.plugins.push(owner.record);
  adoptPluginRegistryRecords(successor);
  const observe = () => {
    expect(caller.getStore()).toBeUndefined();
    expect(getPluginRuntimeGatewayRequestScope()?.signal).toBeUndefined();
    expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(successor);
    expect(pluginInstanceInvocation.getStore()?.instance).toBe(owner.instance);
    expect(getBoundLegacyPluginSdkResourceHost()).toBe(host);
  };
  const openingScope = {
    isWebchatConnect: () => false,
    signal: new AbortController().signal,
    pluginRegistry: owner.registry,
  };
  const work = () =>
    owner.run(async () => {
      observe();
      await Promise.resolve();
      observe();
    });
  try {
    await caller.run("opening-turn", () =>
      withPluginRuntimeGatewayRequestScope(openingScope, work),
    );
    expect(owner.run(() => 42)).toBe(42);
    const error = new Error("background failure");
    expect(() => owner.run(throwing(error))).toThrow(error);
  } finally {
    await owner.instance.dispose();
    await host.close();
  }
});

it("drains returned work, admits existing cleanup, and never adopts a replacement instance", async () => {
  const owner = fixture();
  const replacement = fixture();
  const gate = createDeferredCore<string>();
  const cleanup = vi.fn(() =>
    owner.run(() => expect(pluginInstanceInvocation.getStore()?.instance).toBe(owner.instance)),
  );
  owner.instance.lifecycle.onDispose(cleanup);
  const pending = owner.run(() => gate.promise);
  const closing = trackCompletion(owner.instance.dispose());
  try {
    expect(() => owner.run(() => "new work")).toThrow("reloaded or disabled");
    await Promise.resolve();
    expect(closing.done).toBe(false);
    gate.resolve("settled");
    await expect(pending).resolves.toBe("settled");
    await expect(closing.promise).resolves.toEqual({ errors: [] });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(() => owner.run(() => "retired")).toThrow("reloaded or disabled");
    expect(replacement.run(() => pluginInstanceInvocation.getStore()?.instance)).toBe(
      replacement.instance,
    );
  } finally {
    gate.resolve("settled");
    await Promise.all([closing.promise, replacement.instance.dispose()]);
  }
});
