import { realpathSync } from "node:fs";
import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";

export type CoordinatorFamily = "gateway-lifecycle" | "state-lifecycle" | "state-handles";

function resolveCoordinatorIdentityPath(pathname: string): string {
  const normalized = path.resolve(pathname);
  try {
    // Live paths need one native lookup, not JavaScript realpath's per-component probes.
    const resolved = path.resolve(realpathSync.native(normalized));
    // Windows native realpath corrects casing; the shipped lock hash preserves input casing.
    if (process.platform !== "win32" || resolved === normalized) {
      return resolved;
    }
  } catch {
    // Missing paths and failed lookups retain the existing ancestor resolution.
  }
  return resolvePathViaExistingAncestorSync(normalized);
}

export function resolveLifecycleCoordinatorBase(params: {
  databasePath: string;
  runtimeDirectory: string;
  uid: number | undefined;
}) {
  const canonicalDatabasePath = resolveCoordinatorIdentityPath(params.databasePath);
  const canonicalRuntimeDirectory = resolveCoordinatorIdentityPath(params.runtimeDirectory);
  // The predecessor state-local coordinator shipped only in v2026.8.1-beta.2.
  // Keep one current stable runtime path; beta-only peers are not upgrade-compatible.
  const suffix =
    params.uid === undefined ? "openclaw-state-locks" : `openclaw-state-locks-${params.uid}`;
  return {
    directory: path.join(canonicalRuntimeDirectory, suffix),
    databaseHash: sha256HexPrefixCore(canonicalDatabasePath, 8),
  };
}

export function buildLifecycleCoordinatorPath(
  family: CoordinatorFamily,
  base: ReturnType<typeof resolveLifecycleCoordinatorBase>,
): string {
  return path.join(base.directory, `${family}.${base.databaseHash}.lock.sqlite`);
}

export function resolveLifecycleCoordinatorPath(
  family: CoordinatorFamily,
  params: Parameters<typeof resolveLifecycleCoordinatorBase>[0],
): string {
  return buildLifecycleCoordinatorPath(family, resolveLifecycleCoordinatorBase(params));
}
