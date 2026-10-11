import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type {
  WorktreeFilesystemBackend,
  WorktreeFilesystemOptions,
} from "./filesystem-backend.types.js";
import { nativeWorktreeFilesystem } from "./filesystem-native.js";

function assertActive(options: WorktreeFilesystemOptions): void {
  options.signal?.throwIfAborted();
  options.commitGuard();
}

async function cloneRefsDirectory(
  source: string,
  destination: string,
  options: WorktreeFilesystemOptions,
  openRoot: typeof import("@openclaw/fs-safe/root").root,
): Promise<void> {
  const stats = await fs.lstat(source);
  if (!stats.isDirectory()) {
    throw new Error(`Worktree template is not a directory: ${source}`);
  }
  const entries = await fs.readdir(source, { withFileTypes: true });
  assertActive(options);
  await fs.mkdir(destination, { mode: 0o700 });
  const destinationRoot = await openRoot(destination);
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await cloneRefsDirectory(sourcePath, destinationPath, options, openRoot);
    } else {
      assertActive(options);
      await destinationRoot.copyIn(entry.name, sourcePath, {
        clone: "always",
        overwrite: false,
        mkdir: false,
        durable: false,
        maxBytes: Infinity,
        preserveSourceMode: true,
        preserveMetadata: true,
        sourceSymlinks: "copy-link",
        sourceHardlinks: "allow",
        mutationSymlinks: "reject",
        signal: options.signal,
        assertBeforeMutation: () => assertActive(options),
      });
      assertActive(options);
      // Let cancellation and allocation-lease renewal run between native file clones.
      await setImmediate();
    }
  }
  // Populate writable directories before restoring their source permissions.
  assertActive(options);
  await fs.chmod(destination, stats.mode & 0o777);
}

/** Probe without creating artifacts; the caller supplies an existing destination parent. */
export async function detectWorktreeFilesystemBackend(
  parentPath: string,
  options: WorktreeFilesystemOptions,
): Promise<WorktreeFilesystemBackend | null> {
  assertActive(options);
  const backend = await nativeWorktreeFilesystem.probe(parentPath, options);
  assertActive(options);
  if (process.platform === "win32") {
    if (backend !== "refs") {
      return null;
    }
    const clusterSize = fsSync.statfsSync(parentPath).bsize;
    return {
      id: "refs",
      estimateCloneBytes: (entries, indexBytes) =>
        16 * 1024 ** 2 + 2 * indexBytes + entries * (8192 + clusterSize),
      async createTemplate(destination, templateOptions) {
        assertActive(templateOptions);
        await fs.mkdir(destination);
      },
      async cloneTemplate(source, destination, cloneOptions) {
        const { root } = await import("@openclaw/fs-safe/root");
        await cloneRefsDirectory(source, destination, cloneOptions, root);
      },
    };
  }
  if (backend !== "apfs" && backend !== "btrfs") {
    return null;
  }
  const apfs =
    backend === "apfs" ? (await import("./filesystem-apfs.native.js")).apfsFilesystem : undefined;
  assertActive(options);
  if (apfs) {
    const parentAcl = await apfs.readDirectoryAcl(parentPath, options);
    assertActive(options);
    if (parentAcl === undefined || parentAcl === "inheritable") {
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
    // Btrfs shares directory metadata; APFS allocates file and directory metadata.
    estimateCloneBytes: (entries, indexBytes) =>
      16 * 1024 ** 2 + 2 * indexBytes + (backend === "apfs" ? entries * 8192 : 0),
    async createTemplate(destination, templateOptions) {
      assertActive(templateOptions);
      if (backend === "apfs") {
        await fs.mkdir(destination);
      } else {
        await nativeWorktreeFilesystem.createSource(destination, templateOptions);
      }
      assertActive(templateOptions);
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
