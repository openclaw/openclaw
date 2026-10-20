/** Per-registry command execution admission and retirement drain. */
import { AsyncLocalStorage } from "node:async_hooks";
import { getPluginRegistryResourceOwner, isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";

type PluginCommandExecutionState = {
  count: number;
  waiters: Array<() => void>;
};

type PluginCommandExecutionToken = {
  registry: PluginRegistry;
  active: boolean;
};

const executionStates = new WeakMap<PluginRegistry, PluginCommandExecutionState>();
const executionContext = new AsyncLocalStorage<ReadonlySet<PluginCommandExecutionToken>>();

function getExecutionState(registry: PluginRegistry): PluginCommandExecutionState {
  const existing = executionStates.get(registry);
  if (existing) {
    return existing;
  }
  const created = { count: 0, waiters: [] };
  executionStates.set(registry, created);
  return created;
}

export function getPluginCommandExecutionCount(registryView: PluginRegistry): number {
  const registry = getPluginRegistryResourceOwner(registryView);
  return executionStates.get(registry)?.count ?? 0;
}

export function isPluginCommandExecutionActiveHere(registryView: PluginRegistry): boolean {
  const registry = getPluginRegistryResourceOwner(registryView);
  return [...(executionContext.getStore() ?? [])].some(
    (token) => token.registry === registry && token.active,
  );
}

export async function withPluginCommandExecution<T>(
  registryView: PluginRegistry,
  run: () => T | Promise<T>,
): Promise<{ admitted: true; value: T } | { admitted: false }> {
  const registry = getPluginRegistryResourceOwner(registryView);
  if (isPluginRegistryRetired(registry)) {
    return { admitted: false };
  }
  const state = getExecutionState(registry);
  state.count += 1;
  const token: PluginCommandExecutionToken = { registry, active: true };
  const active = new Set(
    [...(executionContext.getStore() ?? [])].filter((inherited) => inherited.registry !== registry),
  );
  active.add(token);
  try {
    return { admitted: true, value: await executionContext.run(active, run) };
  } finally {
    token.active = false;
    state.count -= 1;
    if (state.count === 0) {
      for (const resolve of state.waiters.splice(0)) {
        resolve();
      }
    }
  }
}

export async function waitForPluginCommandExecutions(registryView: PluginRegistry): Promise<void> {
  const registry = getPluginRegistryResourceOwner(registryView);
  const state = getExecutionState(registry);
  if (state.count === 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    state.waiters.push(resolve);
  });
}
