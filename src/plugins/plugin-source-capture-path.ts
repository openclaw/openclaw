import fs from "node:fs";
import path from "node:path";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import { tryReadDiskSpace } from "../infra/disk-space.js";
import { normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";
import { createPluginSourceValidationError } from "./plugin-instance-error.js";

// Captures must remain recognizable to the native source loader in every scratch location.
export const PLUGIN_SOURCE_CAPTURE_PREFIX = "openclaw-plugin-build-";
export const PLUGIN_SOURCE_SNAPSHOT_PREFIX = "snapshot-v1-";
export const PLUGIN_SOURCE_SNAPSHOT_STAGING_PREFIX = `${PLUGIN_SOURCE_SNAPSHOT_PREFIX}staging-`;

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

/** Refuse new payloads without turning an unavailable statfs into a startup failure. */
export function assertPluginSourceCaptureDiskSpace(target: string): void {
  const disk = tryReadDiskSpace(target);
  if (disk && disk.availableBytes < 512 * 1024 * 1024) {
    throw createPluginSourceValidationError(
      `Plugin source capture refused: ${disk.availableBytes} bytes available at ${disk.checkedPath}; at least 512 MiB required. Free space on this volume and retry the plugin load.`,
    );
  }
}

/**
 * Node extends Windows paths past MAX_PATH for mkdir and file I/O, but not for mkdtemp.
 * Update rehearsal roots are deep, so captures beneath them need the same extension.
 */
export function mkdtempPluginCaptureSync(prefix: string): string {
  assertPluginSourceCaptureDiskSpace(path.dirname(prefix));
  if (process.platform !== "win32") {
    return fs.mkdtempSync(prefix);
  }
  return normalizeWindowsPathPreservingCase(
    fs.mkdtempSync(path.win32.toNamespacedPath(path.win32.resolve(prefix))),
  );
}
