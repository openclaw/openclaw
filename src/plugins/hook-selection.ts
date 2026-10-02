import type { HookRunnerRegistry } from "./hook-registry.types.js";
import {
  isPluginHookReplyDispatchKind,
  type PluginHookName,
  type PluginHookRegistration,
} from "./hook-types.js";
import {
  createPluginToolMatcherScope,
  pluginToolMatcherCoversTool,
  type PluginToolMatcherScope,
} from "./tool-hook-matcher.js";

export function isHookContextEligible(hook: PluginHookRegistration, ctx?: unknown): boolean {
  if (hook.hookName === "reply_dispatch" && hook.eligibleDispatchKinds !== undefined) {
    const kind =
      typeof ctx === "object" && ctx !== null && "dispatchKind" in ctx
        ? ctx.dispatchKind
        : undefined;
    // Unknown callers cannot prove exclusion from a hook, including during recovery checks.
    return !isPluginHookReplyDispatchKind(kind) || hook.eligibleDispatchKinds.includes(kind);
  }
  if (hook.hookName !== "before_agent_reply" || hook.eligibleTriggers === undefined) {
    return true;
  }
  const trigger =
    typeof ctx === "object" && ctx !== null && "trigger" in ctx ? ctx.trigger : undefined;
  return (
    typeof trigger === "string" &&
    hook.eligibleTriggers.some((eligibleTrigger) => eligibleTrigger === trigger)
  );
}

/** Get hooks for a specific hook name, sorted by priority (higher first). */
export function getHooksForName<K extends PluginHookName>(
  registry: HookRunnerRegistry,
  hookName: K,
  ctx?: unknown,
  toolName?: string,
): PluginHookRegistration<K>[] {
  return registry.typedHooks
    .filter(
      (hook): hook is PluginHookRegistration<K> =>
        hook.hookName === hookName && isHookContextEligible(hook, ctx),
    )
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
