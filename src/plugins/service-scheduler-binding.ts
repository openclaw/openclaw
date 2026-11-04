import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginServiceSchedulerV1 } from "./service-scheduler.types.js";

const current = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginServiceSchedulerBinding"),
  () => new AsyncLocalStorage<(() => PluginServiceSchedulerV1) | undefined>(),
);

export const getPluginServiceSchedulerBinding = () => current.getStore();

export function withPluginServiceSchedulerBinding<T>(
  binding: (() => PluginServiceSchedulerV1) | undefined,
  run: () => T,
): T {
  return current.run(binding, run);
}

export function withPluginServiceScheduler<T>(
  scheduler: PluginServiceSchedulerV1,
  run: () => T,
): T {
  return withPluginServiceSchedulerBinding(() => scheduler, run);
}

/** Published factories borrow their caller's admitted lifetime; no process owner is inferred. */
export function resolvePluginServiceScheduler(
  scheduler?: PluginServiceSchedulerV1,
): PluginServiceSchedulerV1 {
  const owner = scheduler ?? current.getStore()?.();
  if (!owner) {
    throw new Error("Plugin service scheduler requires a bound service, account, or CLI owner");
  }
  if (owner.signal.aborted) {
    throw new Error("Plugin service scheduler is closed");
  }
  return owner;
}
