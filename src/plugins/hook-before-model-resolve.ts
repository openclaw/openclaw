import type { PluginHookBeforeModelResolveResult } from "./hook-before-agent-start.types.js";

export function mergeBeforeModelResolveResults(
  previous: PluginHookBeforeModelResolveResult | undefined,
  next: PluginHookBeforeModelResolveResult,
): PluginHookBeforeModelResolveResult {
  return {
    // Keep the first defined override so higher-priority hooks win.
    modelOverride: previous?.modelOverride ?? next.modelOverride,
    providerOverride: previous?.providerOverride ?? next.providerOverride,
    thinkingOverride: previous?.thinkingOverride ?? next.thinkingOverride,
  };
}
