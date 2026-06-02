import type {
  DetachedTaskLifecycleRuntime,
  DetachedTaskLifecycleRuntimeRegistration,
} from "./detached-task-runtime-contract.js";

export type { DetachedTaskLifecycleRuntime, DetachedTaskLifecycleRuntimeRegistration };

let detachedTaskLifecycleRuntimeRegistration: DetachedTaskLifecycleRuntimeRegistration | undefined;

/** Installs the process-wide detached task runtime registration. */
export function registerDetachedTaskLifecycleRuntime(
  pluginId: string,
  runtime: DetachedTaskLifecycleRuntime,
): void {
  detachedTaskLifecycleRuntimeRegistration = {
    pluginId,
    runtime,
  };
}

/** Returns a defensive registration wrapper so callers cannot mutate the slot metadata. */
export function getDetachedTaskLifecycleRuntimeRegistration():
  | DetachedTaskLifecycleRuntimeRegistration
  | undefined {
  if (!detachedTaskLifecycleRuntimeRegistration) {
    return undefined;
  }
  return {
    pluginId: detachedTaskLifecycleRuntimeRegistration.pluginId,
    runtime: detachedTaskLifecycleRuntimeRegistration.runtime,
  };
}

/** Returns the registered runtime instance, if any, for hot-path dispatch. */
export function getRegisteredDetachedTaskLifecycleRuntime():
  | DetachedTaskLifecycleRuntime
  | undefined {
  return detachedTaskLifecycleRuntimeRegistration?.runtime;
}

/** Restores a previously captured registration after plugin activation rollback. */
export function restoreDetachedTaskLifecycleRuntimeRegistration(
  registration: DetachedTaskLifecycleRuntimeRegistration | undefined,
): void {
  detachedTaskLifecycleRuntimeRegistration = registration
    ? {
        pluginId: registration.pluginId,
        runtime: registration.runtime,
      }
    : undefined;
}

/** Clears the detached task runtime registration so core fallback behavior applies. */
export function clearDetachedTaskLifecycleRuntimeRegistration(): void {
  detachedTaskLifecycleRuntimeRegistration = undefined;
}
