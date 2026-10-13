import path from "node:path";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";

// Captures must remain recognizable to the native source loader in every scratch location.
export const PLUGIN_SOURCE_CAPTURE_PREFIX = "openclaw-plugin-build-";

export function resolvePluginSourceCapturesDirectory(stateDir: string): string {
  return path.join(stateDir, "tmp", "plugin-captures");
}

export function resolvePluginSourceCaptureFallbackPrefix(stateDir: string): string {
  const identity = resolveIdentityPathViaExistingAncestorSync(stateDir);
  return `openclaw-plugin-captures-${sha256HexPrefixCore(identity, 32)}-`;
}

export function isLegacyPluginSourceCaptureName(name: string): boolean {
  return (
    name.startsWith(PLUGIN_SOURCE_CAPTURE_PREFIX) || name.startsWith("openclaw-model-catalog-")
  );
}
