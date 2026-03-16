import type { PluginBundleFormat, PluginFormat, PluginOrigin, PluginTrustTier } from "./types.js";

/**
 * Resolves the trust tier for a plugin based on its format and origin.
 *
 * `bundleFormat` and `origin` are accepted but unused today — forward-compatible
 * for when the sandboxed tier lands and certain origins/subformats need
 * different treatment.
 */
export function resolveTrustTier(params: {
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  origin: PluginOrigin;
}): PluginTrustTier {
  if (params.format === "bundle") {
    return "content";
  }
  if (params.format === "openclaw") {
    return "native";
  }
  // Safe fallback for unknown or undefined formats
  return "content";
}
