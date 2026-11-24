import { isHookContextEligible } from "./hook-context-eligibility.js";
import type { HookRunnerRegistry } from "./hook-registry.types.js";
import type { PluginHookName, PluginHookRegistration } from "./hook-types.js";
import {
  createPluginToolMatcherScope,
  pluginToolMatcherCoversTool,
  type PluginToolMatcherScope,
} from "./tool-hook-matcher.js";

/** Get hooks for a specific hook name, sorted by priority (higher first). */
export function getHooksForName<K extends PluginHookName>(
  registry: HookRunnerRegistry,
  hookName: K,
  ctx?: unknown,
  toolName?: string,
): PluginHookRegistration<K>[] {
  // SAFETY: the hookName filter below keeps only registrations for K.
  return (registry.typedHooks as PluginHookRegistration<K>[])
    .filter((hook) => hook.hookName === hookName && isHookContextEligible(hook, ctx))
    .filter((hook) => toolName === undefined || pluginToolMatcherCoversTool(hook.matcher, toolName))
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

export function getToolHookMatcherScope(
  registry: HookRunnerRegistry,
  hookName: "before_tool_call" | "after_tool_call",
): PluginToolMatcherScope | undefined {
  return createPluginToolMatcherScope(
    getHooksForName(registry, hookName).map((registration) => registration.matcher),
  );
}

export function getHooksForNameAndPlugin<K extends PluginHookName>(
  registry: HookRunnerRegistry,
  hookName: K,
  pluginId: string,
): PluginHookRegistration<K>[] {
  return getHooksForName(registry, hookName).filter((hook) => hook.pluginId === pluginId);
}
