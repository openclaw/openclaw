import fs from "node:fs/promises";
import path from "node:path";
import { prepareSessionSourceEffect } from "../../config/sessions/session-source-authority.js";
import type {
  WorktreeFilesystemBackend,
  WorktreeFilesystemOptions,
} from "./filesystem-backend.types.js";
import {
  nativeWorktreeFilesystem,
  prepareWorktreeFilesystemMutation,
} from "./filesystem-native.js";
import { setWorktreePreparationTemplate } from "./preparation-timing.js";
import { cloneRefsTreeInWorker } from "./provisioned-copy-host.js";

function assertActive(options: WorktreeFilesystemOptions): void {
  options.signal?.throwIfAborted();
  options.commitGuard();
}

async function createTemplateDirectory(destination: string, options: WorktreeFilesystemOptions) {
  const source = await prepareSessionSourceEffect(options.commitGuard);
  await using _ = { [Symbol.asyncDispose]: async () => await source.release?.() };
  await prepareWorktreeFilesystemMutation(options, source);
  options.signal?.throwIfAborted();
  source.assertCurrent();
  await fs.mkdir(destination);
  options.signal?.throwIfAborted();
  source.assertCurrent();
}

/** Probe without creating artifacts; the caller supplies an existing destination parent. */
export async function detectWorktreeFilesystemBackend(
  parentPath: string,
  options: WorktreeFilesystemOptions,
): Promise<WorktreeFilesystemBackend | null> {
  assertActive(options);
  setWorktreePreparationTemplate("unavailable", { reason: "filesystem-probe" });
  const backend = await nativeWorktreeFilesystem.probe(parentPath, options);
  assertActive(options);
  if (process.platform === "win32") {
    if (backend !== "refs") {
      return null;
    }
    const clusterSize = (await fs.statfs(parentPath)).bsize;
    return {
      id: "refs",
      estimateCloneBytes: (entries, indexBytes) =>
        16 * 1024 ** 2 + 2 * indexBytes + entries * (8192 + clusterSize),
      createTemplate: createTemplateDirectory,
      async cloneTemplate(source, destination, cloneOptions) {
        await cloneRefsTreeInWorker(source, destination, cloneOptions);
      },
    };
  }
  if (backend !== "apfs" && backend !== "btrfs" && backend !== "xfs") {
    return null;
  }
  const apfs =
    backend === "apfs" ? (await import("./filesystem-apfs.native.js")).apfsFilesystem : undefined;
  assertActive(options);
  if (apfs) {
    const parentAcl = await apfs.readDirectoryAcl(parentPath, options);
    assertActive(options);
    if (parentAcl === undefined || parentAcl === "inheritable") {
      setWorktreePreparationTemplate("unavailable", { reason: "parent-acl" });
      return null;
    }
  }
  const assertCloneAcls = async (
    directory: string,
    parent: string,
    aclOptions: WorktreeFilesystemOptions,
  ) => {
    if (!apfs) {
      return;
    }
    const acl = await apfs.readDirectoryAcl(parent, aclOptions);
    if (
      acl === undefined ||
      acl === "inheritable" ||
      (await apfs.readDirectoryAcl(directory, aclOptions)) !== "none"
    ) {
      throw new Error("APFS directory cloning cannot preserve directory ACLs; use Git checkout");
    }
  };
  return {
    id: backend,
    // Btrfs shares directory metadata; APFS and XFS allocate per-entry metadata.
    estimateCloneBytes: (entries, indexBytes) =>
      16 * 1024 ** 2 + 2 * indexBytes + (backend === "btrfs" ? 0 : entries * 8192),
    async createTemplate(destination, templateOptions) {
      if (backend === "apfs") {
        await createTemplateDirectory(destination, templateOptions);
      } else {
        await nativeWorktreeFilesystem.createSource(destination, templateOptions);
      }
    },
    async cloneTemplate(source, destination, cloneOptions) {
      const parent = path.dirname(destination);
      await assertCloneAcls(source, parent, cloneOptions);
      assertActive(cloneOptions);
      // Native writes retain their descriptors until settlement, including after abort.
      await nativeWorktreeFilesystem.copy(source, destination, cloneOptions);
      assertActive(cloneOptions);
      await assertCloneAcls(destination, parent, cloneOptions);
    },
  };
}
