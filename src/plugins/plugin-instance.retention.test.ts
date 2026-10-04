import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { getPluginValueInstance, runPluginCleanup } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  adoptPluginRegistryRecords,
  capturePluginLifecycleAuthority,
  markPluginRecordBorrowed,
  markPluginRegistryActive,
} from "./registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

function createOwnedInstance() {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "retention" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  return { registry, record, instance };
}

it("releases the adopted registry only after consumer and module cleanup settle", async () => {
  const { registry, record, instance } = createOwnedInstance();
  const replacement = createEmptyPluginRegistry();
  replacement.plugins.push(record);
  adoptPluginRegistryRecords(replacement);
  const value = instance.adopt({ execute: () => "owned" });
  const call = instance.wrap(value.execute);
  const consumer = instance.retainConsumer(undefined, registry);
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  instance.onModuleDispose(async () => {
    expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(replacement);
    entered.resolve();
    await finish.promise;
  });
  const disposal = instance.dispose();
  try {
    expect(instance.owner?.revoked).toBe(true);
    expect(instance.owner?.registry).toBe(replacement);
    expect(consumer.run(() => getPluginRuntimeGatewayRequestScope()?.pluginRegistry)).toBe(
      registry,
    );
    expect(() => call()).toThrow(PluginInstanceUnavailableError);
    consumer.release();
    await entered.promise;
    expect(instance.owner?.registry).toBe(replacement);
    finish.resolve();
    expect((await disposal).errors).toEqual([]);
    expect(instance.owner?.registry).toBeUndefined();
    // Removing the value association would turn stale cleanup into an unowned call.
    expect(getPluginValueInstance(value)).toBe(instance);
    expect(() => runPluginCleanup(value, value.execute)).toThrow("retiring");
    expect(() => call()).toThrow(PluginInstanceUnavailableError);
    adoptPluginRegistryRecords(registry);
    expect(instance.owner?.registry).toBeUndefined();
  } finally {
    consumer.release();
    finish.resolve();
    await disposal;
  }
});

it("does not reacquire borrowed authority after its lender releases registry custody", async () => {
  const { registry, record, instance } = createOwnedInstance();
  markPluginRegistryActive(registry);
  const borrower = createEmptyPluginRegistry();
  borrower.plugins.push(record);
  markPluginRecordBorrowed(borrower, record);
  markPluginRegistryActive(borrower);
  const authority = capturePluginLifecycleAuthority(borrower, record);
  expect(authority?.()).toBe(true);
  expect(instance.owner?.registry).toBe(registry);
  await instance.dispose();
  expect(instance.owner?.registry).toBeUndefined();
  expect(authority?.()).toBe(false);
  expect(capturePluginLifecycleAuthority(borrower, record)).toBeUndefined();
});

it.each(["host", "module"] as const)(
  "retains registry custody after %s cleanup fails",
  async (kind) => {
    const { registry, instance } = createOwnedInstance();
    const failure = new Error("cleanup prerequisite failed");
    const fail = () => {
      throw failure;
    };
    if (kind === "module") {
      instance.onModuleDispose(fail);
    }
    const disposal = instance.dispose(kind === "host" ? fail : undefined);
    if (kind === "host") {
      await expect(disposal).rejects.toBe(failure);
    } else {
      expect((await disposal).errors).toContain(failure);
    }
    expect(instance.owner?.registry).toBe(registry);
    expect(instance.owner?.revoked).toBe(true);
    expect(() => instance.run(() => "late")).toThrow(PluginInstanceUnavailableError);
  },
);
