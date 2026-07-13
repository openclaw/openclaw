import type { HookRunnerRegistry } from "./hook-registry.types.js";
import type {
  PluginHookInboundClaimResult,
  PluginHookName,
  PluginHookRegistration,
} from "./hook-types.js";

export type PluginTargetedInboundClaimOutcome =
  | { status: "handled"; result: PluginHookInboundClaimResult }
  | { status: "missing_plugin" }
  | { status: "no_handler" }
  | { status: "declined" }
  | { status: "error"; error: string };

/** Return hooks for one name in descending priority order. */
export function getHooksForName<K extends PluginHookName>(
  registry: HookRunnerRegistry,
  hookName: K,
): PluginHookRegistration<K>[] {
  return (registry.typedHooks as PluginHookRegistration<K>[])
    .filter((hook) => hook.hookName === hookName)
    .toSorted((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
}

/** Return one plugin's hooks for a name in descending priority order. */
export function getHooksForNameAndPlugin<K extends PluginHookName>(
  registry: HookRunnerRegistry,
  hookName: K,
  pluginId: string,
): PluginHookRegistration<K>[] {
  return getHooksForName(registry, hookName).filter((hook) => hook.pluginId === pluginId);
}
