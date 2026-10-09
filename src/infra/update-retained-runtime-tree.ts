import fs from "node:fs/promises";
import path from "node:path";
import { collectPluginSafetyInspectedFiles } from "../plugins/plugin-safety-inspected-files.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { root as openRoot } from "./fs-safe.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { copyUpdateCandidatePluginFileBytes } from "./update-candidate-plugin-file.js";
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
  const assertEntry = async (entry: UpdateCandidatePluginEntry) => {
    await params.onProgress?.();
    assertUpdateCandidatePluginEntryStat(entry, await fs.lstat(entry.path, { bigint: true }));
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
      assertAfterCopy: () => assertEntry(entry),
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
    await assertEntry(entry);
    const destination = destinationFor(entry.path);
    const directory = entry.kind === "directory" ? destination : path.dirname(destination);
    // A file may precede its parent's inventory entry; reuse only completed creation.
    await prepareDirectory(directory, entry.kind === "directory" ? entry.mode | 0o700 : 0o700);
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
        try {
          await fs.link(entry.path, destination);
        } catch (error) {
          if (!isLinkUnsupported(error)) {
            throw error;
          }
          copy = true;
        }
      }
      if (copy) {
        await copyEntry(entry, destination);
        counts.copied += 1;
      } else {
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
        assertUpdateCandidatePluginEntryStat(entry, linked);
        counts.linked += 1;
      }
    }
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
