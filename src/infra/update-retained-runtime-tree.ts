import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { collectPluginSafetyInspectedFiles } from "../plugins/plugin-safety-inspected-files.js";
import { sameFileMutationMetadata } from "./file-descriptor.js";
import { root as openRoot } from "./fs-safe.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { copyUpdateCandidatePluginFileBytes } from "./update-candidate-plugin-file.js";
import { runUpdateCandidatePluginTasks } from "./update-candidate-plugin-tasks.js";
import {
  assertUpdateCandidatePluginEntryStat,
  assertUpdateCandidatePluginLinkTarget,
  publishUpdateCandidatePluginTreeLinks,
  resolveUpdateCandidatePluginTreeTargets,
  verifyUpdateCandidatePluginTree,
} from "./update-candidate-plugin-tree-links.js";
import type {
  UpdateCandidatePluginEntry,
  UpdateCandidatePluginTreePlan,
} from "./update-candidate-plugin-tree-schema.js";
import {
  relocateRuntimeSymlink,
  resolveRuntimeFileRelocator,
} from "./update-runtime-relocation.js";

const isLinkUnsupported = (error: unknown) =>
  ["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS"].some((code) =>
    hasNodeErrorCode(error, code),
  );

/**
 * Retain the admitted tree by hard-linking its files into the private directory.
 *
 * Retention only needs the inventoried inodes to outlive the installer's rename or
 * unlink, so files share their inode with the source and bytes are copied only when
 * the filesystem cannot preserve identity, a plugin boundary checks it, or relocation rewrites it.
 * One walk performs the inventory check, publication, relocation, and escape check
 * for every entry.
 */
export async function linkUpdateCandidatePluginTrees(
  plan: UpdateCandidatePluginTreePlan,
  params: {
    targetStateDir: string;
    candidateRoot: string;
    assertCurrent: () => void;
    onProgress?: () => void | Promise<void>;
    onMaterialized?: () => void;
  },
): Promise<{ linked: number; copied: number }> {
  // Temporary CI diagnostics; remove before production integration.
  const diagnostics = process.env.OPENCLAW_RETAINED_ALIAS_DIAGNOSTICS === "1";
  const started = diagnostics ? performance.now() : 0;
  const counts = { linked: 0, copied: 0 };
  let completed = 0;
  let aliasesVerified = 0;
  let modesCompleted = 0;
  let admissionCtimeChanges = 0;
  type Operation =
    | "source-stat"
    | "admission"
    | "directory-wait"
    | "mkdir"
    | "link"
    | "destination-stat"
    | "destination-check"
    | "window-drain";
  type Timing = { operation: Operation; started: number };
  const inflight = new Set<Timing>();
  const measurements = new Map<Operation, { count: number; total: number; max: number }>();
  const begin = (operation: Operation): Timing | undefined => {
    if (!diagnostics) {
      return undefined;
    }
    const timing = { operation, started: performance.now() };
    inflight.add(timing);
    return timing;
  };
  const end = (timing: Timing | undefined) => {
    if (!timing) {
      return;
    }
    const elapsed = performance.now() - timing.started;
    const totals = measurements.get(timing.operation) ?? { count: 0, total: 0, max: 0 };
    totals.count++;
    totals.total += elapsed;
    totals.max = Math.max(totals.max, elapsed);
    measurements.set(timing.operation, totals);
    inflight.delete(timing);
  };
  const trace = (stage: string) => {
    if (diagnostics) {
      // Six snapshots at most. Timings include continuation/diagnostic overhead; totals overlap.
      const snapshot =
        stage === "entry-walk-completed" ||
        stage === "entry-walk-failed" ||
        (stage === "entry-completed" && [1, 4096, 8192, 16384, 32768].includes(completed));
      process.stderr.write(
        JSON.stringify({
          phase: "retained-tree",
          stage,
          elapsedMs: Math.round(performance.now() - started),
          entries: plan.entries.length,
          completed,
          ...counts,
          aliasesVerified,
          modesCompleted,
          ...(snapshot
            ? {
                // Tuples: operation, settled attempts, total milliseconds, max milliseconds.
                timings: Array.from(measurements, ([operation, totals]) => [
                  operation,
                  totals.count,
                  Math.round(totals.total),
                  Math.round(totals.max),
                ]),
                // No timer: fully stalled work cannot emit a new snapshot.
                inflight: Array.from(inflight, (timing) => [
                  timing.operation,
                  Math.round(performance.now() - timing.started),
                ]),
                admissionCtimeChanges,
              }
            : {}),
        }) + "\n",
      );
    }
  };
  trace("targets-start");
  const targets = resolveUpdateCandidatePluginTreeTargets(plan, params);
  trace("targets-completed");
  const { privateRoot, candidateRoot, hostLinks, relocations, destinationFor } = targets;
  const assertEntry = async (entry: UpdateCandidatePluginEntry) => {
    await params.onProgress?.();
    const sourceStat = begin("source-stat");
    let current: BigIntStats;
    try {
      current = await fs.lstat(entry.path, { bigint: true });
    } finally {
      end(sourceStat);
    }
    const admission = begin("admission");
    try {
      if (diagnostics && entry.kind === "file" && current.ctimeNs.toString() !== entry.ctimeNs) {
        // Candidates, not hash calls: earlier admission checks may reject first.
        admissionCtimeChanges++;
      }
      assertUpdateCandidatePluginEntryStat(entry, current);
    } finally {
      end(admission);
    }
    if (entry.kind === "symlink" && (await fs.readlink(entry.path)) !== entry.link) {
      throw new Error(`Plugin entry changed after snapshot inventory: ${entry.path}`);
    }
    return current;
  };
  trace("manifest-checks-start");
  for (const entry of plan.entries) {
    if (path.basename(entry.path) === "openclaw.plugin.json") {
      await assertEntry(entry);
    }
  }
  trace("manifest-checks-completed");
  trace("plugin-safety-start");
  const pluginFiles = collectPluginSafetyInspectedFiles(plan.entries);
  trace("plugin-safety-completed");
  trace("initial-bindings-start");
  await targets.assertBindings();
  trace("initial-bindings-completed");
  params.assertCurrent();
  const rootMkdir = begin("mkdir");
  try {
    await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
  } finally {
    end(rootMkdir);
  }
  const preparedDirectories = new Map<string, Promise<string | undefined>>([
    [privateRoot, Promise.resolve(undefined)],
  ]);
  const directoryTimings = new WeakMap<Promise<string | undefined>, Timing>();
  const prepareDirectory = (directory: string, mode: number) => {
    let preparing = preparedDirectories.get(directory);
    if (!preparing) {
      params.assertCurrent();
      const mkdir = begin("mkdir");
      preparing = fs.mkdir(directory, { recursive: true, mode });
      if (mkdir) {
        // Settled by the first existing waiter, including its continuation delay.
        directoryTimings.set(preparing, mkdir);
      }
      preparedDirectories.set(directory, preparing);
    }
    return preparing;
  };
  let destinationRoot: ReturnType<typeof openRoot> | undefined;
  const copyEntry = async (
    entry: Extract<UpdateCandidatePluginEntry, { kind: "file" }>,
    destination: string,
  ) => {
    const root = await (destinationRoot ??= openRoot(privateRoot));
    await copyUpdateCandidatePluginFileBytes({ entry, privateRoot, destination }, root, {
      assertBeforeMutation: params.assertCurrent,
      assertAfterCopy: async () => {
        await assertEntry(entry);
      },
    });
    const relocate = resolveRuntimeFileRelocator(destination);
    if (relocate) {
      await relocate(destination, entry.path, destination, relocations, params.assertCurrent);
    }
    if ((entry.mode & 0o600) !== 0o600) {
      params.assertCurrent();
      await fs.chmod(destination, entry.mode);
    }
  };
  // OverlayFS hard links can copy lower-layer files up, changing birthtime (or
  // inode identity). Copy instead of relaxing the admitted file fingerprint.
  const copyDevices = new Map<string, boolean>();
  const requiresCopy = async (entry: UpdateCandidatePluginEntry) => {
    if (process.platform !== "linux") {
      return false;
    }
    let copy = copyDevices.get(entry.dev);
    if (copy === undefined) {
      copy = (await fs.statfs(entry.path)).type === 0x794c7630;
      copyDevices.set(entry.dev, copy);
    }
    return copy;
  };
  trace("entry-walk-start");
  const directories: Array<Extract<UpdateCandidatePluginEntry, { kind: "directory" }>> = [];
  const materialize = async (entry: UpdateCandidatePluginEntry) => {
    const admitted = await assertEntry(entry);
    const destination = destinationFor(entry.path);
    const directory = entry.kind === "directory" ? destination : path.dirname(destination);
    // A file may precede its parent's inventory entry; reuse only completed creation.
    const preparing = prepareDirectory(
      directory,
      entry.kind === "directory" ? entry.mode | 0o700 : 0o700,
    );
    const directoryWait = begin("directory-wait");
    try {
      await preparing;
    } finally {
      end(directoryWait);
      if (diagnostics) {
        end(directoryTimings.get(preparing));
        directoryTimings.delete(preparing);
      }
    }
    if (entry.kind === "directory") {
      directories.push(entry);
    } else if (entry.kind === "symlink") {
      params.assertCurrent();
      await fs.symlink(entry.link, destination, entry.linkType);
      await relocateRuntimeSymlink(
        destination,
        entry.path,
        destination,
        relocations,
        params.assertCurrent,
      );
      assertUpdateCandidatePluginLinkTarget(
        destination,
        path.resolve(path.dirname(destination), await fs.readlink(destination)),
        { privateRoot, candidateRoot },
      );
    } else {
      let copy =
        pluginFiles.has(entry.path) ||
        Boolean(resolveRuntimeFileRelocator(destination)) ||
        (await requiresCopy(entry));
      if (!copy) {
        params.assertCurrent();
        const linking = begin("link");
        try {
          await fs.link(entry.path, destination);
        } catch (error) {
          if (!isLinkUnsupported(error)) {
            throw error;
          }
          copy = true;
        } finally {
          end(linking);
        }
      }
      if (copy) {
        await copyEntry(entry, destination);
        counts.copied += 1;
      } else {
        // The private name must reference the inventoried inode, never a newer file.
        const destinationStat = begin("destination-stat");
        let linked: BigIntStats;
        try {
          linked = await fs.lstat(destination, { bigint: true });
        } finally {
          end(destinationStat);
        }
        const destinationCheck = begin("destination-check");
        try {
          if (
            !linked.isFile() ||
            linked.dev.toString() !== entry.dev ||
            linked.ino.toString() !== entry.ino ||
            !sameFileMutationMetadata(admitted, linked)
          ) {
            throw new Error(
              `Retained runtime entry does not reference its inventoried file: ${entry.path}`,
            );
          }
        } finally {
          end(destinationCheck);
        }
        // Our link changes ctime without changing bytes. Accept that change;
        // concurrent equal-size writes restoring mtime during this await are
        // outside this retention check. Later aliases still validate inventory.
        counts.linked += 1;
      }
    }
    params.onMaterialized?.();
    if (diagnostics) {
      completed++;
      // First completion plus at most 32 milestones, independent of graph size.
      if (completed === 1 || (completed % 1024 === 0 && completed <= 32768)) {
        trace("entry-completed");
      }
    }
  };
  const files: Array<Extract<UpdateCandidatePluginEntry, { kind: "file" }>> = [];
  const inodes = new Set<string>();
  const drain = async () => {
    const windowDrain = begin("window-drain");
    try {
      await runUpdateCandidatePluginTasks(files.map((entry) => () => materialize(entry)));
    } finally {
      end(windowDrain);
    }
    files.length = 0;
    inodes.clear();
  };
  try {
    for (const entry of plan.entries) {
      const inode = `${entry.dev}:${entry.ino}`;
      // A link changes its inode's ctime even when the next occurrence needs a copy.
      // Keep shared inodes and directory/symlink barriers in inventory order.
      if (files.length && (entry.kind !== "file" || files.length === 4 || inodes.has(inode))) {
        await drain();
      }
      if (entry.kind === "file") {
        files.push(entry);
        inodes.add(inode);
      } else {
        await materialize(entry);
      }
    }
    if (files.length) {
      await drain();
    }
  } catch (error) {
    trace("entry-walk-failed");
    throw error;
  }
  trace("entry-walk-completed");
  trace("final-bindings-start");
  await targets.assertBindings();
  trace("final-bindings-completed");
  trace("aliases-publish-start");
  const privateAliases = await publishUpdateCandidatePluginTreeLinks({
    privateRoot,
    candidateRoot,
    hostLinks,
    aliases: targets.aliases,
    assertBeforeMutation: params.assertCurrent,
  });
  trace("aliases-publish-completed");
  trace("aliases-verify-start");
  for (const alias of privateAliases) {
    await verifyUpdateCandidatePluginTree(alias, { privateRoot, candidateRoot, hostLinks });
    if (diagnostics) {
      aliasesVerified++;
      if (aliasesVerified === 1 || (aliasesVerified % 64 === 0 && aliasesVerified <= 512)) {
        trace("alias-verified");
      }
    }
  }
  trace("aliases-verify-completed");
  trace("modes-start");
  for (const entry of directories.toSorted((left, right) => right.path.length - left.path.length)) {
    params.assertCurrent();
    await fs.chmod(destinationFor(entry.path), entry.mode);
    params.onMaterialized?.();
    if (diagnostics) {
      modesCompleted++;
      if (modesCompleted === 1 || (modesCompleted % 1024 === 0 && modesCompleted <= 8192)) {
        trace("mode-completed");
      }
    }
  }
  trace("modes-completed");
  return counts;
}
