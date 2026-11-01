import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { vi, type MockInstance } from "vitest";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { createDeferredCore } from "../shared/deferred.js";

export const firstReloaded = { runtime: { pluginIds: ["first"] } };
export const reloadFailure = (phase: "prepare" | "drain" | "activate", committed = false) => ({
  details: { phase, committed },
});

export function pluginInstance(registry: PluginRegistry, id = "first") {
  const record = registry.plugins.find((entry) => entry.id === id);
  assert(record);
  const instance = getPluginInstance(record);
  assert(instance);
  return instance;
}

export function heldWork() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  return {
    entered: entered.promise,
    enter: entered.resolve,
    wait: release.promise,
    release: release.resolve,
    run: () => {
      entered.resolve();
      return release.promise;
    },
  };
}

export function observeSettlement<T>(work: Promise<T>) {
  const state: { settled: boolean; value: unknown } = { settled: false, value: undefined };
  const record = (result: unknown) => {
    state.settled = true;
    state.value = result;
    return result;
  };
  return { state, result: work.then(record, record) };
}

export function rejectWith(error: Error) {
  return async () => {
    throw error;
  };
}

export async function probeHttpRoute(
  handler: PluginRegistry["httpRoutes"][number]["handler"],
  inspect: (response: ServerResponse, end: MockInstance<ServerResponse["end"]>) => void,
) {
  const request = new IncomingMessage(new Socket());
  const response = new ServerResponse(request);
  const end = vi.spyOn(response, "end").mockReturnValue(response);
  try {
    await handler(request, response);
    inspect(response, end);
  } finally {
    request.destroy();
    response.destroy();
  }
}
