import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isPidDefinitelyDeadAsync } from "../shared/pid-alive.js";
import { hasErrnoCode, ignoreMissingPath } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { readPackageName } from "./package-json.js";
import { readPackageReleaseLeases, packageReleaseLeaseDir } from "./package-release-lease.js";
import {
  PACKAGE_RELEASES_DIR,
  packageReleaseGlobalRoot,
  readPackageReleaseSlotSync,
  type PackageReleaseSlot,
} from "./package-release-slot-path.js";
import { readPackageReleaseIdentity, type PackageReleaseIdentity } from "./package-release-slot.js";
import type { ReleaseCandidate, ReleaseHolderResults } from "./release-holder-inspection.js";
import type { UpdateRunRecord } from "./update-run-record.js";

/** Covers a process that started from a release but has not taken its lease yet. */
export const PACKAGE_RELEASE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export type PackageReleaseEntry = PackageReleaseIdentity & {
  id: string;
  selected: boolean;
  leased: boolean;
};

const releasesDirOf = (prefix: string) => path.join(prefix, PACKAGE_RELEASES_DIR);

/**
 * Where a release keeps its package: at the link's path below the prefix, or at npm's
 * `lib/node_modules/<name>`, where Git releases lived before they moved out (#201874).
 */
function packageRootsIn(releasePrefix: string, selected: PackageReleaseSlot): string[] {
  return [
    ...new Set([
      path.join(releasePrefix, path.relative(selected.prefix, selected.slot)),
      path.join(packageReleaseGlobalRoot(releasePrefix), path.basename(selected.slot)),
      // Windows `npm install -g --prefix` puts the package under `<prefix>/node_modules`.
      path.join(releasePrefix, "node_modules", path.basename(selected.slot)),
    ]),
  ];
}

/** Releases under the prefix, newest first, with what keeps each one. */
export async function listPackageReleases(slot: string): Promise<PackageReleaseEntry[]> {
  const selected = readPackageReleaseSlotSync(slot);
  if (!selected) {
    return [];
  }
  const releasesDir = releasesDirOf(selected.prefix);
  const entries: (PackageReleaseEntry & { changedAt: number })[] = [];
  for (const id of await fs.readdir(releasesDir)) {
    if (id.startsWith(".")) {
      continue;
    }
    let identity: Awaited<ReturnType<typeof readPackageReleaseIdentity>> | null = null;
    for (const root of packageRootsIn(path.join(releasesDir, id), selected)) {
      identity ??= await readPackageReleaseIdentity(root).catch(() => null);
    }
    const stat = await fs.stat(path.join(releasesDir, id)).catch(() => null);
    if (!identity || !stat) {
      continue;
    }
    entries.push({
      ...identity,
      id,
      selected: id === selected.releaseId,
      leased: readPackageReleaseLeases(selected.prefix, id).live > 0,
      changedAt: stat.mtimeMs,
    });
  }
  return entries
    .toSorted((left, right) => right.changedAt - left.changedAt)
    .map(({ changedAt: _changedAt, ...entry }) => entry);
}

function namedBy(run: UpdateRunRecord): string[] {
  const release = run.origin.packageRelease;
  const capture = run.origin.updateRecoveryCapture;
  return [
    release?.from.path,
    release?.to.path,
    run.origin.packageStage?.packageRoot,
    capture?.retirement?.installRoot,
    capture?.forwardResolution?.binding.installRoot,
    capture?.forwardResolution?.repair.root,
  ].filter((root) => root !== undefined);
}

// Only names emitted by allocateStaging or createGitRelease are release candidates in the
// resident store. Private operator directories in the same prefix are not ours to collect.
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const releaseName = `(?:${uuid}|git-[a-z0-9]+-[0-9a-f]{8})`;
const residentId = new RegExp(`^${releaseName}$`, "u");
const claimedResident = new RegExp(
  `^[.]collecting-(?:${releaseName}|[.]staging-[1-9][0-9]*-${uuid})-[a-f0-9]{8}$`,
  "u",
);
const unownedStage = new RegExp(`^[.]staging-${uuid}$`, "u");
const stageId = new RegExp(`^[.]staging-([1-9][0-9]*)-(${uuid})$`, "u");

/** Count logical bytes as cleanup --dry-run does: lstat leaves, never follow links. */
async function retainedReleaseWarning(root: string, error: unknown) {
  let bytes = 0;
  let incomplete = false;
  const dirs = [root];
  while (dirs.length) {
    const dir = dirs.pop()!;
    try {
      if (!(await fs.lstat(dir)).isDirectory()) {
        continue;
      }
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          dirs.push(file);
        } else {
          bytes += (await fs.lstat(file)).size;
        }
      }
    } catch {
      incomplete = true;
    }
  }
  return { bytes, incomplete, detail: `${root}: ${formatErrorMessage(error)}` };
}

export type ReleaseCleanupFailure = Awaited<ReturnType<typeof retainedReleaseWarning>>;
export function describeRetainedReleases(failures: ReleaseCleanupFailure[]): string {
  const bytes = failures.reduce((sum, failure) => sum + failure.bytes, 0);
  return `Retained ${failures.some((failure) => failure.incomplete) ? "at least " : ""}${bytes} logical bytes after ${failures.length} cleanup ${failures.length === 1 ? "failure" : "failures"}. ${failures.map((failure) => failure.detail).join("; ")}`;
}

/** An owned tree is removed only after it leaves the selectable namespace. */
export async function discardReleaseTree(
  root: string,
  alreadyClaimed = false,
): Promise<ReleaseCleanupFailure | undefined> {
  let retained = root;
  try {
    if (!alreadyClaimed) {
      const claimed = path.join(
        path.dirname(root),
        `.collecting-${path.basename(root)}-${randomBytes(4).toString("hex")}`,
      );
      await fs.rename(root, claimed);
      retained = claimed;
    }
    await fs.rm(retained, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") && !(await fs.lstat(retained).catch(ignoreMissingPath))) {
      return undefined;
    }
    return retainedReleaseWarning(retained, error);
  }
}

export async function collectPackageReleases(params: {
  slot: string;
  prefix: string;
  keep?: readonly string[];
  readOpenRuns?: () => Promise<UpdateRunRecord[]>;
  env?: NodeJS.ProcessEnv;
  now?: number;
  /** The resident preparer knows the last trial's two sides, including the last deselection. */
  resident?: {
    knownTrial: boolean;
    rolledBack?: { root: string; runId: string };
    interrupted?: string;
  };
}): Promise<{ removed: string[]; warnings: string[] }> {
  const failures: ReleaseCleanupFailure[] = [];
  const warnings: string[] = [];
  const removed: string[] = [];
  const selected = readPackageReleaseSlotSync(params.slot);
  if (selected ? selected.prefix !== params.prefix : !params.resident) {
    return { removed, warnings };
  }
  const releasesDir = releasesDirOf(params.prefix);
  if (!(await fs.lstat(releasesDir)).isDirectory()) {
    return {
      removed,
      warnings: ["Release collection skipped; releases is not a physical directory."],
    };
  }
  const entries = await fs.readdir(releasesDir, { withFileTypes: true });
  if (!entries.some((entry) => entry.isDirectory() && entry.name !== ".leases")) {
    return { removed, warnings };
  }
  const now = params.now ?? Date.now();
  let openRuns: UpdateRunRecord[];
  try {
    openRuns = await (
      params.readOpenRuns ??
      (async () => {
        const { listUpdateRunsAsync } = await import("./update-run-reader.js");
        return listUpdateRunsAsync(
          { active: true, limit: 100 },
          { env: params.env },
          { current: true },
        );
      })
    )();
  } catch (error) {
    return {
      removed,
      warnings: [
        `Release collection skipped; open update runs are unreadable: ${formatErrorMessage(error)}`,
      ],
    };
  }
  if (openRuns.length >= 100) {
    return {
      removed,
      warnings: ["Release collection skipped; the active update run list may be incomplete."],
    };
  }
  const kept = new Set(
    await Promise.all(
      [...(params.keep ?? []), ...openRuns.flatMap(namedBy)].map(
        async (root) => (await fs.realpath(root).catch(ignoreMissingPath)) ?? path.resolve(root),
      ),
    ),
  );
  const leaseBase = await fs.lstat(path.join(releasesDir, ".leases")).catch(ignoreMissingPath);
  if (leaseBase && !leaseBase.isDirectory()) {
    return {
      removed,
      warnings: ["Release collection skipped; lease directory is not a physical directory."],
    };
  }
  const abandoned: ReleaseCandidate[] = [];
  const discard = async (directory: string, claimed = false) => {
    const warning = await discardReleaseTree(directory, claimed);
    if (warning) {
      failures.push(warning);
    } else if (!claimed) {
      removed.push(directory);
      await fs.rm(packageReleaseLeaseDir(releasesDir, path.basename(directory)), {
        recursive: true,
        force: true,
      });
    }
  };
  for (const entry of entries) {
    const id = entry.name;
    if (!entry.isDirectory() || id === selected?.releaseId) {
      continue;
    }
    const directory = path.join(releasesDir, id);
    if ([...kept].some((root) => root === directory || root.startsWith(directory + path.sep))) {
      continue;
    }
    const resident = params.resident;
    const claimed = resident ? claimedResident.test(id) : id.startsWith(".collecting-");
    const stage = resident ? stageId.exec(id) : null;
    const failedTrial =
      resident?.rolledBack?.root === path.join(directory, "openclaw")
        ? resident.rolledBack
        : undefined;
    const interrupted = resident?.interrupted === id;
    const runId = stage?.[2] ?? failedTrial?.runId ?? id;
    if (openRuns.some((run) => run.runId === id || run.runId === runId)) {
      continue;
    }
    try {
      if (resident && unownedStage.test(id)) {
        failures.push(
          await retainedReleaseWarning(
            directory,
            "An earlier preparer did not record its staging owner; not removed automatically.",
          ),
        );
        continue;
      }
      if (!claimed && !stage && (id.startsWith(".") || (resident && !residentId.test(id)))) {
        continue;
      }
      if (readPackageReleaseLeases(params.prefix, id).live) {
        continue;
      }
      if (claimed) {
        await discard(directory, true);
        continue;
      }
      if (stage) {
        if (await isPidDefinitelyDeadAsync(Number(stage[1]))) {
          abandoned.push({ runId, directory });
        }
        continue;
      }
      if (resident) {
        // A UUID-shaped backup is not a published release. Do not follow aliased manifests.
        let owned = false;
        for (const root of selected
          ? packageRootsIn(directory, selected)
          : [path.join(directory, "openclaw")]) {
          const manifest = path.join(root, "package.json");
          if (
            (await fs.realpath(manifest).catch(ignoreMissingPath)) === manifest &&
            (await readPackageName(root)) === "openclaw"
          ) {
            owned = true;
            break;
          }
        }
        if (!owned) {
          continue;
        }
        if (failedTrial || interrupted) {
          abandoned.push({ runId, directory });
          continue;
        }
        if (!id.startsWith("git-")) {
          // Published UUIDs are their preparation run IDs, even after a later trial replaces
          // .trial or a Gateway settles a dead lock. Only committed runs are ordinary releases.
          const { getUpdateRunForProgressAsync } = await import("./update-run-reader.js");
          const run = await getUpdateRunForProgressAsync(id, { env: params.env });
          if (!run || run.status === "running") {
            if (!run) {
              failures.push(
                await retainedReleaseWarning(
                  directory,
                  "No update outcome identifies this release.",
                ),
              );
            }
            continue;
          }
          if (run.status !== "succeeded") {
            if (run.reason === "interrupted") {
              const stageName = run.steps.find(({ step }) => step === "staging")?.detail ?? "";
              const owner = stageId.exec(stageName);
              if (owner?.[2] !== id) {
                failures.push(
                  await retainedReleaseWarning(
                    directory,
                    "The interrupted preparer's identity could not be verified.",
                  ),
                );
                continue;
              }
              if (!(await isPidDefinitelyDeadAsync(Number(owner[1])))) {
                continue;
              }
            }
            abandoned.push({ runId, directory });
            continue;
          }
        }
      }
      if (
        selected &&
        (resident?.knownTrial ||
          now - (await fs.lstat(directory)).mtimeMs >= PACKAGE_RELEASE_MIN_AGE_MS)
      ) {
        await discard(directory);
      }
    } catch (error) {
      failures.push(await retainedReleaseWarning(directory, error));
    }
  }
  if (abandoned.length) {
    let observations: ReleaseHolderResults = {};
    let inspectionError: unknown = "Release processes are still running or could not be verified.";
    try {
      const { inspectReleaseHolders } = await import("./release-holder-inspection.js");
      observations = await inspectReleaseHolders(abandoned);
    } catch (error) {
      inspectionError = error;
    }
    for (const { directory } of abandoned) {
      try {
        if (observations[directory] === "clear") {
          await discard(directory);
        } else {
          failures.push(await retainedReleaseWarning(directory, inspectionError));
        }
      } catch (error) {
        failures.push(await retainedReleaseWarning(directory, error));
      }
    }
  }
  if (failures.length) {
    warnings.push(describeRetainedReleases(failures));
  }
  return { removed, warnings };
}
