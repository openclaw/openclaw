import fs from "node:fs";
import path from "node:path";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import { normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";

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

/** Node supports long Windows paths for I/O but `mkdtemp` still needs namespacing. */
export function mkdtempPluginCaptureSync(prefix: string): string {
  if (process.platform !== "win32") {
    return fs.mkdtempSync(prefix);
  }
  return normalizeWindowsPathPreservingCase(
    fs.mkdtempSync(path.win32.toNamespacedPath(path.win32.resolve(prefix))),
  );
}
