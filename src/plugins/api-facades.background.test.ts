import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { buildPluginApi, createUnavailableRuntime } from "./api-builder.js";
import { instrumentPluginInstanceApi } from "./api-facades.js";
import {
  LegacyPluginSdkResourceHost,
  getBoundLegacyPluginSdkResourceHost,
} from "./legacy-sdk-resource-host.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { adoptPluginRegistryRecords } from "./registry-lifecycle.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

function fixture() {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "background-owner" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { registry, record });
  const api = instrumentPluginInstanceApi(
    buildPluginApi({
      id: record.id,
      name: record.id,
      source: record.source,
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

describe("instance-bound background context", () => {
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
    try {
      await caller.run("opening-turn", () =>
        withPluginRuntimeGatewayRequestScope(
          {
            isWebchatConnect: () => false,
            signal: new AbortController().signal,
            pluginRegistry: owner.registry,
          },
          () =>
            owner.run(async () => {
              observe();
              await Promise.resolve();
              observe();
            }),
        ),
      );
      expect(owner.run(() => 42)).toBe(42);
      const error = new Error("background failure");
      expect(() =>
        owner.run(() => {
          throw error;
        }),
      ).toThrow(error);
    } finally {
      await owner.instance.dispose();
      await host.close();
    }
  });

  it("drains returned work, admits existing cleanup, and never adopts a replacement instance", async () => {
    const owner = fixture();
    const replacement = fixture();
    const gate = createDeferredCore<string>();
    const enteredCleanup = createDeferredCore();
    owner.instance.lifecycle.onDispose(() =>
      owner.run(() => {
        expect(pluginInstanceInvocation.getStore()?.instance).toBe(owner.instance);
        enteredCleanup.resolve();
      }),
    );
    const pending = owner.run(() => gate.promise);
    let disposed = false;
    const closing = owner.instance.dispose().then((result) => {
      disposed = true;
      return result;
    });
    try {
      expect(() => owner.run(() => "new work")).toThrow("reloaded or disabled");
      await Promise.resolve();
      expect(disposed).toBe(false);
      gate.resolve("settled");
      await expect(pending).resolves.toBe("settled");
      await enteredCleanup.promise;
      await expect(closing).resolves.toEqual({ errors: [] });
      expect(() => owner.run(() => "retired")).toThrow("reloaded or disabled");
      expect(replacement.run(() => pluginInstanceInvocation.getStore()?.instance)).toBe(
        replacement.instance,
      );
    } finally {
      gate.resolve("settled");
      await Promise.all([closing, replacement.instance.dispose()]);
    }
  });

  it("lets resource cleanup await background completion without joining its own disposal", async () => {
    vi.useFakeTimers();
    const owner = fixture();
    const gate = createDeferredCore();
    const pending = owner.run(() => gate.promise);
    let cleaned = false;
    owner.instance.lifecycle.onDispose(async () => {
      await pending;
      cleaned = true;
    });
    const closing = owner.instance.dispose();
    void pending.catch(() => {});
    try {
      gate.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(closing).resolves.toEqual({ errors: [] });
      await expect(pending).resolves.toBeUndefined();
      expect(cleaned).toBe(true);
    } finally {
      gate.resolve();
      await Promise.allSettled([pending, closing]);
      vi.useRealTimers();
    }
  });
});
