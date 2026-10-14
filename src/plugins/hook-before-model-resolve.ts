import type { PluginHookBeforeModelResolveResult } from "./hook-types.js";

export function mergeBeforeModelResolveResults(
  previous: PluginHookBeforeModelResolveResult | undefined,
  next: PluginHookBeforeModelResolveResult,
  normalizeFallbacks: (value: unknown) => string[] | undefined,
): PluginHookBeforeModelResolveResult {
  return {
    // Keep the first defined override so higher-priority hooks win, including [].
    modelOverride: previous?.modelOverride ?? next.modelOverride,
    providerOverride: previous?.providerOverride ?? next.providerOverride,
    thinkingOverride: previous?.thinkingOverride ?? next.thinkingOverride,
    fallbacksOverride: previous?.fallbacksOverride ?? normalizeFallbacks(next.fallbacksOverride),
  };
}
