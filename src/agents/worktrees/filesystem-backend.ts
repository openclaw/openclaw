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
  cloneFile: (source: string, destination: string) => void,
): Promise<void> {
  const stats = await fs.lstat(source);
  if (!stats.isDirectory()) {
    throw new Error(`Worktree template is not a directory: ${source}`);
  }
  const entries = await fs.readdir(source, { withFileTypes: true });
  assertActive(options);
  await fs.mkdir(destination, { mode: 0o700 });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await cloneRefsDirectory(sourcePath, destinationPath, options, cloneFile);
    } else {
      assertActive(options);
      cloneFile(sourcePath, destinationPath);
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
  if (process.platform === "win32") {
    // ReFS requires the live host guard before each file; the bulk API cannot supply it.
    const { refsFilesystem } = await import("./filesystem-refs.native.js");
    assertActive(options);
    const volume = refsFilesystem.probe(parentPath);
    if (!volume) {
      return null;
    }
    return {
      id: "refs",
      estimateCloneBytes: (entries, indexBytes) =>
        16 * 1024 ** 2 + 2 * indexBytes + entries * (8192 + volume.clusterSize),
      async createTemplate(destination, templateOptions) {
        assertActive(templateOptions);
        await fs.mkdir(destination);
      },
      async cloneTemplate(source, destination, cloneOptions) {
        await cloneRefsDirectory(source, destination, cloneOptions, (from, to) =>
          refsFilesystem.cloneFile(from, to, volume.clusterSize),
        );
      },
    };
  }
  const backend = await nativeWorktreeFilesystem.probe(parentPath, options);
  assertActive(options);
  if (backend !== "apfs" && backend !== "btrfs") {
    return null;
  }
  const apfs =
    backend === "apfs" ? (await import("./filesystem-apfs.native.js")).apfsFilesystem : undefined;
  assertActive(options);
  if (apfs) {
    const parentAcl = apfs.readDirectoryAcl(parentPath);
    if (parentAcl === undefined || parentAcl === "inheritable") {
      return null;
    }
  }
  const assertCloneAcls = (directory: string, parent: string) => {
    if (!apfs) {
      return;
    }
    const acl = apfs.readDirectoryAcl(parent);
    if (acl === undefined || acl === "inheritable" || apfs.readDirectoryAcl(directory) !== "none") {
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
      assertCloneAcls(source, parent);
      assertActive(cloneOptions);
      // Native writes retain their descriptors until settlement, including after abort.
      await nativeWorktreeFilesystem.copy(source, destination, cloneOptions);
      assertActive(cloneOptions);
      assertCloneAcls(destination, parent);
    },
  };
}
