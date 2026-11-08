// Checkout-scoped exclusion for runtime artifact writers. A publication whose
// outputs the profile's installed Gateway cannot reach skips the profile-wide
// service lifecycle lock; this owner keeps service retarget/startup away from
// that checkout's physical outputs for the whole writer interval instead.
// Keys cover the canonical runtime output roots (not only the package root), so
// supported shared-output layouts — a second checkout whose dist directories
// symlink into the publishing one — exclude on the same physical identity.
import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "./crypto-digest.js";
import { hasErrnoCode } from "./errno.js";
import { FILE_LOCK_TIMEOUT_ERROR_CODE, withFileLock, type FileLockOptions } from "./file-lock.js";
import { readPackageName } from "./package-json.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

const EXCLUSION_LOCK_OPTIONS: FileLockOptions = {
  retries: { retries: 120, factor: 1.1, minTimeout: 25, maxTimeout: 250 },
  stale: 30_000,
  // Reclaim only a definitely retired writer; age alone cannot prove it stopped.
  staleRecovery: "remove-if-definitely-stale",
};

/**
 * Canonical runtime output paths a publication writes and a served Gateway
 * consumes. The SDK alias is included because it is the supported shared-output
 * seam: a served checkout's alias can physically point into another checkout
 * that is publishing, and both sides must derive the same physical key for it.
 */
export const RUNTIME_PUBLICATION_OUTPUT_ROOTS: readonly string[] = [
  "dist",
  "dist-runtime",
  path.join("dist", "extensions", "node_modules", "openclaw"),
];

/**
 * Physical identity of a possibly missing output path. Resolution follows
 * symlink targets even while they are absent — a shared alias whose target is
 * mid-clean must still resolve into the publisher's namespace — then falls back
 * to the nearest existing ancestor plus the unresolved tail, so a rebuild that
 * has cleaned its dist directories derives the same key the writer holds.
 */
async function resolvePhysicalOutputKey(candidate: string, linkBudget = 8): Promise<string> {
  let current = path.resolve(candidate);
  const tail: string[] = [];
  for (;;) {
    const real = await fs.realpath(current).catch(() => undefined);
    if (real !== undefined) {
      return tail.length === 0 ? real : path.join(real, ...tail.toReversed());
    }
    if (linkBudget > 0) {
      const target = await fs.readlink(current).catch(() => undefined);
      if (target !== undefined) {
        return await resolvePhysicalOutputKey(
          path.resolve(path.dirname(current), target),
          linkBudget - 1,
        );
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    tail.push(path.basename(current));
    current = parent;
  }
}

/** Nearest ancestor (inclusive) that is an `openclaw` package root, bounded. */
async function nearestOpenClawPackageRoot(physical: string): Promise<string | undefined> {
  let current = physical;
  // Bound the walk like the service layout resolver: deep pnpm layouts only.
  for (let depth = 0; depth < 16; depth += 1) {
    if ((await readPackageName(current)) === "openclaw") {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

/** Every physical identity to exclude for one root: the root plus its output roots.
 * Each key is additionally coordinated with its nearest enclosing `openclaw`
 * package root, so a consumer path that resolves *inside* another checkout's
 * outputs (nested shared topology) collides with the key that checkout's own
 * publication always holds for its root. */
export async function resolveRuntimePublicationExclusionKeys(
  root: string,
  outputs?: readonly string[],
): Promise<string[]> {
  const candidates = [
    root,
    ...RUNTIME_PUBLICATION_OUTPUT_ROOTS.map((output) => path.join(root, output)),
    ...(outputs ?? []).map((output) => path.join(root, output)),
  ];
  const keys = new Set<string>();
  for (const candidate of candidates) {
    const physical = await resolvePhysicalOutputKey(candidate);
    keys.add(physical);
    const owner = await nearestOpenClawPackageRoot(physical);
    if (owner !== undefined) {
      keys.add(owner);
    }
  }
  // One global acquisition order keeps concurrent multi-key holders deadlock-free.
  return [...keys].toSorted();
}

/** Machine-wide identity of one runtime publication output; profiles share it. */
export function resolveRuntimePublicationExclusionPath(physicalKey: string): string {
  return path.join(
    resolvePreferredOpenClawTmpDir({ purpose: "coordination" }),
    `runtime-publication-${sha256Hex(physicalKey)}`,
  );
}

async function withOrderedPublicationExclusions<T>(
  keys: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const acquire = async (index: number): Promise<T> => {
    if (index >= keys.length) {
      return await run();
    }
    const key = keys[index];
    if (key === undefined) {
      return await run();
    }
    return await withFileLock(
      resolveRuntimePublicationExclusionPath(key),
      EXCLUSION_LOCK_OPTIONS,
      async () => await acquire(index + 1),
    );
  };
  return await acquire(0);
}

/** Hold the exclusion for one root's physical outputs. An unresolvable root has no outputs to exclude. */
export async function withRuntimePublicationExclusion<T>(
  root: string | undefined,
  publish: () => Promise<T>,
  outputs?: readonly string[],
): Promise<T> {
  const real = root ? await fs.realpath(root).catch(() => undefined) : undefined;
  if (!real) {
    return await publish();
  }
  return await withOrderedPublicationExclusions(
    await resolveRuntimePublicationExclusionKeys(real, outputs),
    publish,
  );
}

/** Service mutations serving a root wait for its writer; a wait that outlives the
 * budget reports the publication instead of a bare lock timeout. */
export async function withServedRootPublicationExclusion<T>(
  root: string | undefined,
  mutate: () => Promise<T>,
): Promise<T> {
  try {
    return await withRuntimePublicationExclusion(root, mutate);
  } catch (error) {
    if (!hasErrnoCode(error, FILE_LOCK_TIMEOUT_ERROR_CODE)) {
      throw error;
    }
    throw new Error(
      `Runtime artifacts in ${root} are still being published by another command. Wait for that build or update to finish, then retry the service operation.`,
      { cause: error },
    );
  }
}
