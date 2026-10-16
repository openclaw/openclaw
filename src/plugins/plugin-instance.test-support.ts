import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, onTestFinished } from "vitest";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { adoptPluginRegistryRecords } from "./registry-lifecycle.js";
import type { PluginRecord } from "./registry-types.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

export function createOwnedInstance(id: string, origin: PluginRecord["origin"] = "workspace") {
  const record = createPluginRecord({ id, origin });
  const registry = { ...createEmptyPluginRegistry(), plugins: [record] };
  const instance = new PluginInstance(id, { record, registry });
  return { instance, record, registry };
}

export function createOwnedTestInstance(id: string, origin?: PluginRecord["origin"]) {
  const { instance } = createOwnedInstance(id, origin);
  disposeAfterTest(instance);
  return instance;
}

export function selectRegistry(record: PluginRecord, label: string, marker: object = {}) {
  const registry = Object.assign(marker, createEmptyPluginRegistry(), {
    plugins: [record],
    coreGatewayMethodNames: [label],
  });
  adoptPluginRegistryRecords(registry);
  return registry;
}

export const readRegistryLabel = () =>
  getPluginRuntimeGatewayRequestScope()?.pluginRegistry?.coreGatewayMethodNames[0];

export async function expectLiveObjects(constructor: Function, count: number) {
  await setImmediate();
  expect(queryObjects(constructor)).toBe(count);
}

/** Release ordinary fixtures even when an assertion fails; protocol waits stay in their tests. */
export function createTestInstance(...args: ConstructorParameters<typeof PluginInstance>) {
  const instance = new PluginInstance(...args);
  disposeAfterTest(instance);
  return instance;
}

function disposeAfterTest(instance: PluginInstance) {
  onTestFinished(async () => {
    await instance.dispose();
  });
}
