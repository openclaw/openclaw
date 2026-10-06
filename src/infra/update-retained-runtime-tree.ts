import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { collectPluginSafetyInspectedFiles } from "../plugins/plugin-safety-inspected-files.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { root as openRoot } from "./fs-safe.js";
import { hasNodeErrorCode } from "./path-guards.js";
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
  const targets = resolveUpdateCandidatePluginTreeTargets(plan, params);
  const { privateRoot, candidateRoot, hostLinks, relocations, destinationFor } = targets;
  // Linking bumps the source inode's change time. Later entries that share that
  // inode (pnpm store hard links) must match the recorded post-link fingerprint.
  const linkedInodes = new Map<string, string>();
  const assertEntryStat = (entry: UpdateCandidatePluginEntry, current: BigIntStats) => {
    const expected =
      entry.kind === "file" && linkedInodes.has(`${entry.dev}:${entry.ino}`)
        ? { ...entry, ctimeNs: linkedInodes.get(`${entry.dev}:${entry.ino}`)! }
        : entry;
    assertUpdateCandidatePluginEntryStat(expected, current);
  };
  const assertEntry = async (entry: UpdateCandidatePluginEntry) => {
    await params.onProgress?.();
    assertEntryStat(entry, await fs.lstat(entry.path, { bigint: true }));
    if (entry.kind === "symlink" && (await fs.readlink(entry.path)) !== entry.link) {
      throw new Error(`Plugin entry changed after snapshot inventory: ${entry.path}`);
    }
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
  const preparedDirectories = new Set([privateRoot]);
  const preparingDirectories = new Map<string, Promise<void>>();
  const prepareDirectory = async (directory: string, mode: number) => {
    if (preparedDirectories.has(directory)) {
      return;
    }
    let preparing = preparingDirectories.get(directory);
    if (!preparing) {
      params.assertCurrent();
      preparing = fs.mkdir(directory, { recursive: true, mode }).then(() => {
        preparedDirectories.add(directory);
        preparingDirectories.delete(directory);
      });
      preparingDirectories.set(directory, preparing);
    }
    await preparing;
  };
  let destinationRoot: ReturnType<typeof openRoot> | undefined;
  const copyEntry = async (
    entry: Extract<UpdateCandidatePluginEntry, { kind: "file" }>,
    destination: string,
  ) => {
    const root = await (destinationRoot ??= openRoot(privateRoot));
    // copyIn owns portable create-only publication; recheck the inventory before
    // its private stage is published.
    await root.copyIn(path.relative(privateRoot, destination), entry.path, {
      overwrite: false,
      // The entry loop already prepares each destination parent.
      mkdir: false,
      // Process-lifetime scratch like the unsynced hard-link path, never a recovery backup.
      durable: false,
      clone: "auto",
      maxBytes: entry.size,
      mode: entry.mode | 0o600,
      sourceHardlinks: "allow",
      assertBeforeMutation: () => {
        params.assertCurrent();
        assertEntryStat(entry, fsSync.lstatSync(entry.path, { bigint: true }));
      },
    });
    await assertEntry(entry);
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
    await assertEntry(entry);
    const destination = destinationFor(entry.path);
    const directory = entry.kind === "directory" ? destination : path.dirname(destination);
    // A file may precede its parent's inventory entry; reuse only completed creation.
    await prepareDirectory(directory, entry.kind === "directory" ? entry.mode | 0o700 : 0o700);
    if (entry.kind === "directory") {
      directories.push(entry);
      params.onMaterialized?.();
      return;
    }
    if (entry.kind === "symlink") {
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
      params.onMaterialized?.();
      return;
    }
    if (
      pluginFiles.has(entry.path) ||
      resolveRuntimeFileRelocator(destination) ||
      (await requiresCopy(entry))
    ) {
      await copyEntry(entry, destination);
      counts.copied += 1;
      params.onMaterialized?.();
      return;
    }
    params.assertCurrent();
    try {
      await fs.link(entry.path, destination);
    } catch (error) {
      if (!isLinkUnsupported(error)) {
        throw error;
      }
      await copyEntry(entry, destination);
      counts.copied += 1;
      params.onMaterialized?.();
      return;
    }
    // The private name must reference the inventoried inode, never a newer file.
    const linked = await fs.lstat(destination, { bigint: true });
    if (
      !linked.isFile() ||
      linked.dev.toString() !== entry.dev ||
      linked.ino.toString() !== entry.ino
    ) {
      throw new Error(
        `Retained runtime entry does not reference its inventoried file: ${entry.path}`,
      );
    }
    assertUpdateCandidatePluginEntryStat({ ...entry, ctimeNs: linked.ctimeNs.toString() }, linked);
    linkedInodes.set(`${entry.dev}:${entry.ino}`, linked.ctimeNs.toString());
    counts.linked += 1;
    params.onMaterialized?.();
  };
  const files: Array<Extract<UpdateCandidatePluginEntry, { kind: "file" }>> = [];
  const inodes = new Set<string>();
  const drain = async () => {
    const result = await runTasksWithConcurrency({
      tasks: files.map((entry) => () => materialize(entry)),
      limit: 4,
      errorMode: "stop",
    });
    // Cleanup must never race an admitted filesystem write, including on failure.
    if (result.hasError) {
      throw result.firstError;
    }
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
  return counts;
}
