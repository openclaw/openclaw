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
  // Temporary isolated-composition probe; remove with OPENCLAW_RETAINED_CLI_TRACE.
  const traceEnabled = process.env.OPENCLAW_RETAINED_CLI_TRACE === "1";
  const startedAt = traceEnabled ? performance.now() : 0;
  type Operation =
    | "source-stat"
    | "source-check"
    | "parent-ready"
    | "link"
    | "copy"
    | "destination-stat"
    | "destination-check";
  const timings = new Map<Operation, { count: number; totalMs: number; maxMs: number }>();
  const start = () => (traceEnabled ? performance.now() : 0);
  const record = (operation: Operation, started: number) => {
    if (!traceEnabled) {
      return;
    }
    const elapsedMs = performance.now() - started;
    const value = timings.get(operation) ?? { count: 0, totalMs: 0, maxMs: 0 };
    value.count += 1;
    value.totalMs += elapsedMs;
    value.maxMs = Math.max(value.maxMs, elapsedMs);
    timings.set(operation, value);
  };
  let completed = 0;
  const snapshot = () => {
    if (traceEnabled) {
      // Three records at most. Concurrent/nested totals overlap and include continuations.
      console.error(JSON.stringify({
        phase: "cli-composition-retention-trace",
        stage: "materialization-costs",
        elapsedMs: Math.round(performance.now() - startedAt),
        completed,
        preparedDirectories: preparedDirectories.size,
        ...counts,
        timings: Array.from(timings, ([operation, value]) => ({
          operation,
          count: value.count,
          totalMs: Math.round(value.totalMs),
          maxMs: Math.round(value.maxMs),
        })),
      }));
    }
  };
  const targets = resolveUpdateCandidatePluginTreeTargets(plan, params);
  const { privateRoot, candidateRoot, hostLinks, relocations, destinationFor } = targets;
  const assertEntry = async (entry: UpdateCandidatePluginEntry) => {
    await params.onProgress?.();
    const sourceStatStartedAt = start();
    const current = await fs.lstat(entry.path, { bigint: true });
    record("source-stat", sourceStatStartedAt);
    const sourceCheckStartedAt = start();
    assertUpdateCandidatePluginEntryStat(entry, current);
    record("source-check", sourceCheckStartedAt);
    if (entry.kind === "symlink" && (await fs.readlink(entry.path)) !== entry.link) {
      throw new Error(`Plugin entry changed after snapshot inventory: ${entry.path}`);
    }
    return current;
  };
  for (const entry of plan.entries) {
    if (path.basename(entry.path) === "openclaw.plugin.json") {
      await assertEntry(entry);
    }
  }
  const pluginFiles = collectPluginSafetyInspectedFiles(plan.entries);
  await targets.assertBindings();
  params.assertCurrent();
  await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const preparedDirectories = new Map<string, Promise<string | undefined>>([
    [privateRoot, Promise.resolve(undefined)],
  ]);
  const prepareDirectory = (directory: string, mode: number) => {
    let preparing = preparedDirectories.get(directory);
    if (!preparing) {
      params.assertCurrent();
      preparing = fs.mkdir(directory, { recursive: true, mode });
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
  const counts = { linked: 0, copied: 0 };
  const directories: Array<Extract<UpdateCandidatePluginEntry, { kind: "directory" }>> = [];
  const materialize = async (entry: UpdateCandidatePluginEntry) => {
    const admitted = await assertEntry(entry);
    const destination = destinationFor(entry.path);
    const directory = entry.kind === "directory" ? destination : path.dirname(destination);
    // A file may precede its parent's inventory entry; reuse only completed creation.
    const parentStartedAt = start();
    await prepareDirectory(directory, entry.kind === "directory" ? entry.mode | 0o700 : 0o700);
    record("parent-ready", parentStartedAt);
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
        const linkStartedAt = start();
        try {
          await fs.link(entry.path, destination);
        } catch (error) {
          if (!isLinkUnsupported(error)) {
            throw error;
          }
          copy = true;
        } finally {
          record("link", linkStartedAt);
        }
      }
      if (copy) {
        const copyStartedAt = start();
        await copyEntry(entry, destination);
        record("copy", copyStartedAt);
        counts.copied += 1;
      } else {
        // The private name must reference the inventoried inode, never a newer file.
        const destinationStatStartedAt = start();
        const linked = await fs.lstat(destination, { bigint: true });
        record("destination-stat", destinationStatStartedAt);
        const destinationCheckStartedAt = start();
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
        record("destination-check", destinationCheckStartedAt);
        // Our link changes ctime without changing bytes. Accept that change;
        // concurrent equal-size writes restoring mtime during this await are
        // outside this retention check. Later aliases still validate inventory.
        counts.linked += 1;
      }
    }
    params.onMaterialized?.();
    if (traceEnabled) {
      completed += 1;
      if (completed === 4096 || completed === 16384) {
        snapshot();
      }
    }
  };
  const files: Array<Extract<UpdateCandidatePluginEntry, { kind: "file" }>> = [];
  const inodes = new Set<string>();
  const drain = async () => {
    await runUpdateCandidatePluginTasks(files.map((entry) => () => materialize(entry)));
    files.length = 0;
    inodes.clear();
  };
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
  await targets.assertBindings();
  const privateAliases = await publishUpdateCandidatePluginTreeLinks({
    privateRoot,
    candidateRoot,
    hostLinks,
    aliases: targets.aliases,
    assertBeforeMutation: params.assertCurrent,
  });
  for (const alias of privateAliases) {
    await verifyUpdateCandidatePluginTree(alias, { privateRoot, candidateRoot, hostLinks });
  }
  for (const entry of directories.toSorted((left, right) => right.path.length - left.path.length)) {
    params.assertCurrent();
    await fs.chmod(destinationFor(entry.path), entry.mode);
    params.onMaterialized?.();
  }
  snapshot();
  return counts;
}
