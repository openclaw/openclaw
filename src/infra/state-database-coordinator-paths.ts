import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveIdentityPathViaExistingAncestorSync,
  resolvePathViaExistingAncestorSync,
} from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import { isPathInside } from "./path-guards.js";
import { getVitestResourceContext } from "./vitest-resource-ownership.js";

// The launcher publishes this before application imports; production has no test context.
const resourceContext = getVitestResourceContext();
const resourceOwners = resourceContext?.kind === "owned" ? resourceContext.owners : [];
const productionRuntimeDirectory =
  resourceContext?.kind === "owned"
    ? resourceContext.productionRuntimeDirectory
    : process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "OpenClaw", "locks")
      : "/tmp";

export function findLifecycleResourceOwner(targetPath: string) {
  if (resourceOwners.length === 0) {
    return undefined;
  }
  return findCanonicalLifecycleResourceOwner(
    resolveIdentityPathViaExistingAncestorSync(targetPath),
  );
}

function findCanonicalLifecycleResourceOwner(canonical: string) {
  let nearest: (typeof resourceOwners)[number] | undefined;
  for (const owner of resourceOwners) {
    if (
      isPathInside(owner.root, canonical) &&
      (!nearest || owner.root.length > nearest.root.length)
    ) {
      nearest = owner;
    }
  }
  return nearest;
}

export function resolveDefaultLifecycleRuntimeDirectory(databasePath?: string): string {
  return (
    (databasePath ? findLifecycleResourceOwner(databasePath)?.root : undefined) ??
    productionRuntimeDirectory
  );
}

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
  const requestedRuntimeDirectory = resolveCoordinatorIdentityPath(params.runtimeDirectory);
  const defaultRuntimeDirectory = resolveCoordinatorIdentityPath(productionRuntimeDirectory);
  const databaseOwner = findCanonicalLifecycleResourceOwner(canonicalDatabasePath);
  const runtimeOwner = findCanonicalLifecycleResourceOwner(requestedRuntimeDirectory);
  // Explicit private runtimes remain private. External databases must still contend
  // with production even when a test worker inherited its owner's temporary root.
  const canonicalRuntimeDirectory = databaseOwner
    ? requestedRuntimeDirectory === defaultRuntimeDirectory
      ? databaseOwner.root
      : requestedRuntimeDirectory
    : runtimeOwner
      ? defaultRuntimeDirectory
      : requestedRuntimeDirectory;
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
