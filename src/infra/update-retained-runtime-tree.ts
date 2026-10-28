import fs from "node:fs/promises";
import path from "node:path";
import { collectPluginSafetyInspectedFiles } from "../plugins/plugin-safety-inspected-files.js";
import { hashFileMutationSnapshotSync } from "./file-descriptor.js";
import { root as openRoot } from "./fs-safe.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { copyUpdateCandidatePluginFileBytes } from "./update-candidate-plugin-file.js";
import { runUpdateCandidatePluginTasks } from "./update-candidate-plugin-tasks.js";
import {
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
 * Same-inode source edits remain best effort. Changed identities (including
 * filesystem copy-up) must match inventory before this generation can be used.
 */
export async function linkUpdateCandidatePluginTrees(
  plan: UpdateCandidatePluginTreePlan,
  params: {
    targetStateDir: string;
    candidateRoot: string;
    assertCurrent: () => void;
  },
): Promise<{ linked: number; copied: number } | { unusableReason: string }> {
  const targets = resolveUpdateCandidatePluginTreeTargets(plan, params);
  const { privateRoot, candidateRoot, hostLinks, relocations, destinationFor } = targets;
  const pluginFiles = collectPluginSafetyInspectedFiles(plan.entries);
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
    await copyUpdateCandidatePluginFileBytes(
      { entry, privateRoot, destination },
      root,
      params.assertCurrent,
    );
    const relocate = resolveRuntimeFileRelocator(destination);
    if (relocate) {
      await relocate(destination, entry.path, destination, relocations, params.assertCurrent);
    }
    if ((entry.mode & 0o600) !== 0o600) {
      params.assertCurrent();
      await fs.chmod(destination, entry.mode);
    }
  };
  const counts = { linked: 0, copied: 0 };
  let unusableReason: string | undefined;
  const directories: Array<Extract<UpdateCandidatePluginEntry, { kind: "directory" }>> = [];
  const materialize = async (entry: UpdateCandidatePluginEntry) => {
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
      let copy = pluginFiles.has(entry.path) || Boolean(resolveRuntimeFileRelocator(destination));
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
        const linked = await fs.lstat(destination, { bigint: true });
        if (!linked.isFile()) {
          throw new Error(`Retained runtime entry is not a regular file: ${entry.path}`);
        }
        if (linked.dev.toString() !== entry.dev || linked.ino.toString() !== entry.ino) {
          let failedCheck: string | undefined;
          if (linked.size !== BigInt(entry.size)) {
            failedCheck = "size";
          } else if (Number(linked.mode & 0o7777n) !== entry.mode) {
            failedCheck = "mode";
          } else {
            try {
              if (hashFileMutationSnapshotSync(destination, linked) !== entry.sha256) {
                failedCheck = "sha256";
              }
            } catch {
              failedCheck = "sha256";
            }
          }
          if (failedCheck) {
            unusableReason ??= `Retained runtime verification failed (${failedCheck}): ${entry.path}`;
            return;
          }
        } else if (linked.size > BigInt(entry.size)) {
          throw new Error(`Plugin entry changed after snapshot inventory: ${entry.path}`);
        }
        counts.linked += 1;
      }
    }
  };
  const files: Array<Extract<UpdateCandidatePluginEntry, { kind: "file" }>> = [];
  const drain = async () => {
    await runUpdateCandidatePluginTasks(files.map((entry) => () => materialize(entry)));
    files.length = 0;
  };
  for (const entry of plan.entries) {
    if (files.length && (entry.kind !== "file" || files.length === 4)) {
      await drain();
    }
    if (unusableReason) {
      return { unusableReason };
    }
    if (entry.kind === "file") {
      files.push(entry);
    } else {
      await materialize(entry);
    }
  }
  if (files.length) {
    await drain();
  }
  if (unusableReason) {
    return { unusableReason };
  }
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
  }
  return counts;
}
