import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { hasErrnoCode, isErrno } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { isPathInside } from "./path-guards.js";
import type { CommandRunner } from "./update-runner-types.js";
import {
  readRuntimeModulesManifest,
  relocateRuntimeTree,
  type RuntimeRelocation,
} from "./update-runtime-relocation.js";
import { gitRuntimeStagingPath } from "./update-runtime-staging.js";
import type { UpdateStepResult } from "./update-step-result.js";

function readRuntimeEntry(file: string): BigIntStats | undefined {
  try {
    return fsSync.lstatSync(file, { bigint: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function sameRuntimeIdentity(expected: BigIntStats | undefined, current: BigIntStats) {
  return (
    expected !== undefined &&
    expected.dev === current.dev &&
    expected.ino === current.ino &&
    (process.platform !== "win32" || (current.dev !== 0n && current.ino !== 0n))
  );
}

async function collectRuntimeDirectories(
  root: string,
  runCommand: CommandRunner,
  timeoutMs: number,
) {
  const result = await runCommand(
    [
      "git",
      "-C",
      root,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
      "--",
      "dist",
      "dist-runtime",
      "node_modules",
      "**/dist",
      "**/dist-runtime",
      "**/node_modules",
      ":(exclude).artifacts/**",
      ":(exclude).worktrees/**",
      ":(exclude).claude/**",
    ],
    { cwd: root, timeoutMs },
  );
  if (result.code !== 0) {
    throw new Error("Cannot enumerate update runtime outputs");
  }
  // Tracked siblings make Git descend instead of collapsing an ignored output directory.
  const directories = result.stdout
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const parts = entry.split("/");
      const runtimeIndex = parts.findIndex((part) =>
        ["dist", "dist-runtime", "node_modules"].includes(part),
      );
      const runtimeRoot = parts.slice(0, runtimeIndex + 1);
      return runtimeRoot.length && !runtimeRoot.some((part) => part.startsWith("."))
        ? [runtimeRoot.join("/")]
        : [];
    });
  return [...new Set(directories)];
}

async function collectDisposableRuntimeCaches(
  modulesDirs: string[],
  runtimeRoots: string[],
  storeRoots: string[],
) {
  const caches = new Set<string>();
  const overlaps = (left: string, right: string) =>
    isPathInside(left, right) || isPathInside(right, left);
  for (const modulesDir of modulesDirs) {
    // Only these tool-owned defaults are rebuildable. Package-internal caches
    // and pnpm's virtual store can contain required runtime code.
    for (const relative of [".cache/jiti", ".vite", ".vite-temp"]) {
      const cache = path.join(modulesDir, relative);
      try {
        if (
          (await fs.lstat(cache)).isDirectory() &&
          (await fs.realpath(cache)) === cache &&
          !storeRoots.some((store) => overlaps(cache, store))
        ) {
          caches.add(cache);
        }
      } catch {
        // An absent or unresolved tool path is not evidence of a disposable cache.
      }
    }
  }
  // Decide before fs.cp prunes directories: dependency links may appear after
  // their targets. A retained cache can itself reference another cache.
  const pending = [...runtimeRoots];
  const visited = new Set<string>();
  while (caches.size > 0 && pending.length > 0) {
    const entry = pending.pop()!;
    if (visited.has(entry) || caches.has(entry)) {
      continue;
    }
    visited.add(entry);
    const stat = await fs.lstat(entry);
    if (stat.isSymbolicLink()) {
      const target = path.resolve(path.dirname(entry), await fs.readlink(entry));
      const targets = [target];
      try {
        targets.push(await fs.realpath(entry));
      } catch {
        // Verbatim promotion accepts unresolved links. Retain caches when their
        // dependency ownership cannot be established rather than reject an update.
        caches.clear();
        break;
      }
      for (const cache of caches) {
        if (targets.some((dependency) => overlaps(cache, dependency))) {
          caches.delete(cache);
          pending.push(cache);
        }
      }
    } else if (stat.isDirectory()) {
      for (const child of await fs.readdir(entry, { withFileTypes: true })) {
        if (child.isDirectory() || child.isSymbolicLink()) {
          pending.push(path.join(entry, child.name));
        }
      }
    }
  }
  return caches;
}

/** Stage on the destination filesystem; activation only renames the already validated runtime. */
export async function prepareGitRuntimePromotion(
  root: string,
  candidateRoot: string,
  runCommand: CommandRunner,
  timeoutMs: number,
  cleanupRoot: string,
  assertDestination?: (destination: string) => void,
) {
  const relocation: RuntimeRelocation = {
    sourceRoot: await fs.realpath(candidateRoot),
    destinationRoot: await fs.realpath(root),
    sourceAliases: [candidateRoot],
  };
  const directories = await collectRuntimeDirectories(relocation.sourceRoot, runCommand, timeoutMs);
  const copiedRoots = new Map<string, RuntimeRelocation>();
  for (const relative of directories) {
    const sourceRoot = path.join(relocation.sourceRoot, relative);
    copiedRoots.set(sourceRoot, {
      sourceRoot,
      destinationRoot: path.join(relocation.destinationRoot, relative),
    });
  }
  const stores = new Map<string, RuntimeRelocation>();
  const ownedRoot = await fs.realpath(cleanupRoot);
  for (const relative of directories) {
    if (path.basename(relative) !== "node_modules") {
      continue;
    }
    const modulesDir = path.join(relocation.sourceRoot, relative);
    const contents = await readRuntimeModulesManifest(path.join(modulesDir, ".modules.yaml"));
    const virtualStoreDir = contents?.manifest.virtualStoreDir;
    if (typeof virtualStoreDir !== "string") {
      continue;
    }
    const store = path.resolve(modulesDir, virtualStoreDir);
    // Own the directory entry, not a symlink's external payload. A sibling store
    // can be outside the worktree but still inside its disposable preflight tree.
    const sourceRoot = path.join(await fs.realpath(path.dirname(store)), path.basename(store));
    const owned = isPathInside(ownedRoot, sourceRoot);
    const storeRelocation = {
      sourceRoot,
      destinationRoot: owned
        ? path.resolve(relocation.destinationRoot, path.relative(relocation.sourceRoot, sourceRoot))
        : sourceRoot,
      sourceAliases: [store],
    };
    const destinationEntry = path.join(
      resolvePathViaExistingAncestorSync(path.dirname(storeRelocation.destinationRoot)),
      path.basename(storeRelocation.destinationRoot),
    );
    if (
      isPathInside(sourceRoot, relocation.sourceRoot) ||
      (owned && isPathInside(destinationEntry, relocation.destinationRoot))
    ) {
      throw new Error(
        "Update pnpm virtual store overlaps the source or live checkout; use a dedicated store directory before updating.",
      );
    }
    stores.set(sourceRoot, storeRelocation);
    if (owned) {
      copiedRoots.set(sourceRoot, storeRelocation);
    }
  }
  // A store reached through a symlinked parent retains its physical external owner;
  // resolve that specific mapping before the encompassing checkout mapping.
  const relocations = [...stores.values(), relocation];
  const roots = [...copiedRoots.values()].filter(
    (entry) =>
      ![...copiedRoots.keys()].some(
        (other) => other !== entry.sourceRoot && isPathInside(other, entry.sourceRoot),
      ),
  );
  const destinations = roots.map(({ destinationRoot }) =>
    path.join(
      resolvePathViaExistingAncestorSync(path.dirname(destinationRoot)),
      path.basename(destinationRoot),
    ),
  );
  // External payloads may survive a moved symlink, but stores inside renamed
  // directory entries disappear from the candidate's retained dependency links.
  const storeRoots = [...stores.keys()];
  for (const store of stores.keys()) {
    const payload = await fs.realpath(store);
    storeRoots.push(payload, ...(stores.get(store)?.sourceAliases ?? []));
    if (
      (!copiedRoots.has(store) && destinations.some((dest) => isPathInside(dest, store))) ||
      (!roots.some(({ sourceRoot }) => isPathInside(sourceRoot, payload)) &&
        destinations.some((dest) => isPathInside(dest, payload)))
    ) {
      throw new Error("Update pnpm virtual store overlaps a runtime directory being replaced.");
    }
  }
  const disposableCaches = await collectDisposableRuntimeCaches(
    directories
      .filter((relative) => path.basename(relative) === "node_modules")
      .map((relative) => path.join(relocation.sourceRoot, relative)),
    roots.map(({ sourceRoot }) => sourceRoot),
    storeRoots,
  );
  for (const { destinationRoot } of roots) {
    assertDestination?.(destinationRoot);
  }
  const staged: Array<{
    destination: string;
    temporary: string;
    previous: boolean;
    activated: boolean;
    identities?: {
      parent: BigIntStats;
      parentPath: string;
      staging: BigIntStats;
      previous: BigIntStats | undefined;
    };
  }> = [];
  const promoted: typeof staged = [];
  let restoreStarted = false;
  const cleanup = async (assertCurrent = () => {}) => {
    // Failed restoration must retain pending originals; successfully restored
    // entries leave the promoted list before cleanup or another restore attempt.
    const retiring = staged.filter((entry) => !restoreStarted || !promoted.includes(entry));
    // Reject the whole retirement before parallel removal can discard any original.
    for (const entry of retiring) {
      assertDestination?.(entry.destination);
    }
    const removed = await Promise.allSettled(
      retiring.map(async (entry) => {
        assertCurrent();
        assertDestination?.(entry.destination);
        await fs.rm(entry.temporary, { recursive: true, force: true });
        assertCurrent();
      }),
    );
    const failures = removed.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError(failures, "Git runtime backup cleanup did not finish.");
    }
  };
  try {
    for (const { sourceRoot, destinationRoot: destination } of roots) {
      // .artifacts may point at another volume. A sibling of each destination
      // guarantees rename-only activation, including nested workspace outputs.
      assertDestination?.(destination);
      const temporary = gitRuntimeStagingPath(destination);
      const entry = { destination, temporary, previous: false, activated: false };
      staged.push(entry);
      await fs.mkdir(temporary, { recursive: true });
      const candidate = path.join(temporary, "candidate");
      assertDestination?.(destination);
      await fs.cp(sourceRoot, candidate, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        // An unused filter prevents Node from using its native directory-copy path.
        filter: disposableCaches.size > 0 ? (source) => !disposableCaches.has(source) : undefined,
      });
      assertDestination?.(destination);
      await relocateRuntimeTree(candidate, sourceRoot, destination, relocations);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  const assertParents = (entry: (typeof staged)[number]) => {
    const identities = entry.identities;
    const parent = path.dirname(entry.destination);
    const parentStat = fsSync.statSync(parent, { bigint: true });
    const stagingStat = fsSync.lstatSync(entry.temporary, { bigint: true });
    if (
      !identities ||
      !parentStat.isDirectory() ||
      !stagingStat.isDirectory() ||
      fsSync.realpathSync.native(parent) !== identities.parentPath ||
      !sameRuntimeIdentity(identities.parent, parentStat) ||
      !sameRuntimeIdentity(identities.staging, stagingStat)
    ) {
      throw new Error(`Git runtime parent identity changed; retained ${entry.temporary}`);
    }
  };
  const assertPrevious = (entry: (typeof staged)[number]) => {
    if (
      entry.previous &&
      !sameRuntimeIdentity(
        entry.identities?.previous,
        fsSync.lstatSync(path.join(entry.temporary, "previous"), { bigint: true }),
      )
    ) {
      throw new Error(`Retained Git runtime identity changed: ${entry.temporary}`);
    }
  };
  const assertRetainedEntry = (entry: (typeof staged)[number], assertCurrent = () => {}) => {
    assertCurrent();
    assertDestination?.(entry.destination);
    assertParents(entry);
    assertPrevious(entry);
  };
  const restoreEntry = async (entry: (typeof staged)[number], assertCurrent = () => {}) => {
    const guard = () => assertRetainedEntry(entry, assertCurrent);
    guard();
    if (entry.activated) {
      await fs.rm(entry.destination, { recursive: true, force: true });
      if (entry.previous) {
        guard();
      }
    } else if (readRuntimeEntry(entry.destination)) {
      throw new Error(
        `Git runtime destination is occupied during partial recovery: ${entry.destination}`,
      );
    }
    if (entry.previous) {
      // The transaction reserves this name. Refuse observed replacements; this
      // guarded rename does not provide atomic exclusion of external races.
      await fs.rename(path.join(entry.temporary, "previous"), entry.destination);
    }
    // A completed effect must leave rollback custody before a later guard can fail.
    promoted.pop();
    assertCurrent();
    assertDestination?.(entry.destination);
    assertParents(entry);
    if (
      entry.previous &&
      !sameRuntimeIdentity(
        entry.identities?.previous,
        fsSync.lstatSync(entry.destination, { bigint: true }),
      )
    ) {
      throw new Error(`Restored Git runtime identity changed: ${entry.destination}`);
    }
  };
  return {
    backupRoot: staged[0]?.temporary ?? root,
    // Source fences may hide only transaction-owned staging. The same exact
    // paths preserve pending originals while rollback cleans unrelated files.
    sourceTreeStagingPaths: staged.flatMap(({ temporary }) => {
      const relative = path.relative(relocation.destinationRoot, temporary);
      return relative &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
        ? [relative.split(path.sep).join("/")]
        : [];
    }),
    async activate() {
      try {
        for (const entry of staged) {
          assertDestination?.(entry.destination);
        }
        for (const entry of staged) {
          assertDestination?.(entry.destination);
          const parent = path.dirname(entry.destination);
          entry.identities = {
            parent: fsSync.statSync(parent, { bigint: true }),
            parentPath: fsSync.realpathSync.native(parent),
            staging: fsSync.lstatSync(entry.temporary, { bigint: true }),
            previous: readRuntimeEntry(entry.destination),
          };
          assertParents(entry);
          if (
            entry.identities.previous &&
            !sameRuntimeIdentity(entry.identities.previous, entry.identities.previous)
          ) {
            throw new Error(`Git runtime identity is unavailable: ${entry.destination}`);
          }
          try {
            await fs.rename(entry.destination, path.join(entry.temporary, "previous"));
            entry.previous = true;
          } catch (error) {
            if (!hasErrnoCode(error, "ENOENT") || entry.identities.previous) {
              throw error;
            }
          }
          promoted.push(entry);
          try {
            assertRetainedEntry(entry);
            await fs.rename(path.join(entry.temporary, "candidate"), entry.destination);
            entry.activated = true;
          } catch (error) {
            restoreStarted = true;
            if (hasCommandProcessCleanupError(error)) {
              throw error;
            }
            try {
              await restoreEntry(entry);
            } catch (restorationError) {
              throw new AggregateError(
                [error, restorationError],
                `Git runtime activation failed (${formatErrorMessage(error)}); partial restoration failed (${formatErrorMessage(restorationError)}).`,
                { cause: restorationError },
              );
            }
            throw error;
          }
        }
      } catch (error) {
        restoreStarted = true;
        throw error;
      }
    },
    async restore(assertCurrent = () => {}) {
      restoreStarted = true;
      for (const entry of promoted) {
        assertRetainedEntry(entry, assertCurrent);
      }
      for (const entry of promoted.toReversed()) {
        await restoreEntry(entry, assertCurrent);
      }
    },
    cleanup,
  };
}

export function createGitRuntimeTransaction({
  root,
  promotion,
  assertRollbackSafe,
  restoreRuntime,
}: {
  root: string;
  promotion: Pick<Awaited<ReturnType<typeof prepareGitRuntimePromotion>>, "backupRoot"> & {
    cleanup: (assertCurrent?: () => void) => Promise<UpdateStepResult | void>;
  };
  assertRollbackSafe: () => Promise<void>;
  restoreRuntime: PackageUpdateTransaction["rollback"];
}): PackageUpdateTransaction {
  let restored: ReturnType<PackageUpdateTransaction["rollback"]> | undefined;
  let completed: Promise<UpdateStepResult | void> | undefined;
  const retention = (message: string, warning = false): UpdateStepResult => ({
    name: "git-runtime-backup-retention",
    command: "retain previous Git runtime",
    cwd: root,
    durationMs: 0,
    exitCode: 1,
    stderrTail: message,
    ...(warning ? { advisory: { kind: "recoverable-maintenance" as const, message } } : {}),
  });
  return {
    backupRoot: promotion.backupRoot,
    assertRollbackSafe,
    rollback: (assertCurrent) => {
      assertCurrent();
      if (completed) {
        throw new Error("Git runtime backup retirement has already started.");
      }
      return (restored ??= (async () => {
        await assertRollbackSafe();
        assertCurrent();
        return await restoreRuntime(assertCurrent);
      })());
    },
    complete: (outcome, assertCurrent) => {
      assertCurrent();
      return (completed ??= (async () => {
        if (!outcome.activationVerified && (await restored)?.exitCode !== 0) {
          return retention(
            `Git recovery is unverified; previous runtime retained at ${promotion.backupRoot}.`,
          );
        }
        try {
          return await promotion.cleanup(assertCurrent);
        } catch (error) {
          assertCurrent();
          if (
            hasCommandProcessCleanupError(error) ||
            !(error instanceof AggregateError ? error.errors : [error]).every(isErrno)
          ) {
            throw error;
          }
          return retention(
            `Git verification succeeded; backup cleanup remains pending at ${promotion.backupRoot}: ${formatErrorMessage(error)}`,
            true,
          );
        }
      })());
    },
  };
}
