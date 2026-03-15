import fs from "node:fs/promises";
import path from "node:path";
import { findPackageRoot } from "./openclaw-root.js";

export type ShadowInstallWarning = {
  /** Resolved real path of the currently running binary (process.argv[1]). */
  activeBinaryPath: string;
  /** Package root that owns the currently running binary. */
  activeInstallRoot: string;
  /** Package root that was just updated. */
  updatedInstallRoot: string;
};

/**
 * After a successful global-package update, detect whether the binary that
 * the shell will actually invoke (`process.argv[1]`, resolved through
 * symlinks) lives inside a *different* install root than the one we just
 * updated.
 *
 * Returns a warning descriptor when a shadow is detected, or `null` when
 * everything looks fine (or when we can't determine the answer).
 */
export async function detectShadowInstall(params: {
  updatedRoot: string;
}): Promise<ShadowInstallWarning | null> {
  const argv1 = process.argv[1];
  if (!argv1) {
    return null;
  }

  let resolvedBinary: string;
  try {
    resolvedBinary = await fs.realpath(argv1);
  } catch {
    // Can't resolve the binary (e.g. deleted after exec) — nothing to warn about.
    return null;
  }

  let activeRoot: string | null;
  try {
    activeRoot = await findPackageRoot(path.dirname(resolvedBinary));
  } catch {
    return null;
  }
  if (!activeRoot) {
    // Binary doesn't sit inside a recognisable openclaw package tree.
    return null;
  }

  // Note: if realpath fails for one path but not the other, comparison may
  // false-positive. Acceptable since the feature is best-effort and a false
  // warning is safer than a missed shadow.

  // Both paths must be realpath'd for a reliable comparison — the updated
  // root comes from `npm root -g` / findPackageRoot which may contain
  // symlinks, while activeRoot was already found via a realpath'd binary.
  let normalizedUpdated: string;
  try {
    normalizedUpdated = await fs.realpath(params.updatedRoot);
  } catch {
    normalizedUpdated = path.resolve(params.updatedRoot);
  }
  let normalizedActive: string;
  try {
    normalizedActive = await fs.realpath(activeRoot);
  } catch {
    normalizedActive = path.resolve(activeRoot);
  }

  if (normalizedActive === normalizedUpdated) {
    return null;
  }

  return {
    activeBinaryPath: resolvedBinary,
    activeInstallRoot: normalizedActive,
    updatedInstallRoot: normalizedUpdated,
  };
}
