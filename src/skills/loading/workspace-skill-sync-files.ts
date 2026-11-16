import fs from "node:fs";
import path from "node:path";
import {
  assertDirectoryIdentitySync,
  readDirectoryIdentity,
  type DirectoryIdentity,
} from "@openclaw/fs-safe/advanced";
import { sha256File } from "@openclaw/fs-safe/durability";
import { root, type Root } from "@openclaw/fs-safe/root";
import type { SkillLibraryFile } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { tryReadJson } from "../../infra/json-files.js";
import { ensureWritableSkillDirectories } from "./skill-directory-modes.js";
import { shouldSyncSkillPath } from "./skill-paths.js";

const fsp = fs.promises;
const MANIFEST = ".openclaw-sync.json";
const GENERATED_IGNORE_MODE_MASK = process.platform === "win32" ? 0o200 : 0o7777;

type SkillsSyncTarget = { directory: string; identity: DirectoryIdentity };
export type SkillsSyncFilesystemOperation =
  | { operation: "prepare"; directory: string }
  | { operation: "remove-manifest"; target: SkillsSyncTarget }
  | { operation: "remove"; target: SkillsSyncTarget; relativePath: string }
  | {
      operation: "copy";
      target: SkillsSyncTarget;
      source: string;
      destination: string;
      reconcile: boolean;
    }
  | {
      operation: "library";
      target: SkillsSyncTarget;
      destination: string;
      files: SkillLibraryFile[];
    }
  | { operation: "manifest"; target: SkillsSyncTarget; manifest: unknown };
export type SkillsSyncFilesystemPrepared = { target: SkillsSyncTarget; manifest: unknown };

/** Filesystem units keep fs-safe admission and effects on the existing skills worker. */
export async function runSkillsSyncFilesystem(
  request: SkillsSyncFilesystemOperation,
  assertCurrent: () => void,
  phase: (name: string) => void,
): Promise<SkillsSyncFilesystemPrepared | undefined> {
  if (request.operation === "prepare") {
    await ensureSyncedSkillsDirectory(request.directory, assertCurrent);
    assertCurrent();
    phase("root");
    const identity = await readDirectoryIdentity(request.directory + path.sep + ".");
    const target = await root(request.directory, { assertBeforeMutation: assertCurrent });
    assertDirectoryIdentitySync(request.directory + path.sep + ".", identity);
    assertCurrent();
    phase("gitignore");
    const ignore = await target
      .read(".gitignore", { maxBytes: 2, symlinks: "reject" })
      .catch(() => undefined);
    if (
      ignore?.buffer.toString() !== "*\n" ||
      (ignore.stat.mode & GENERATED_IGNORE_MODE_MASK) !== (0o644 & GENERATED_IGNORE_MODE_MASK)
    ) {
      await target.write(".gitignore", "*\n", { mode: 0o644, durable: false });
    }
    assertCurrent();
    phase("manifest_read");
    const manifest = await tryReadJson<unknown>(path.join(request.directory, MANIFEST));
    assertCurrent();
    return { target: { directory: request.directory, identity }, manifest };
  }
  const target = await root(request.target.directory, { assertBeforeMutation: assertCurrent });
  // A later unit must keep the original target, even if another owner replaced its spelling.
  assertDirectoryIdentitySync(request.target.directory + path.sep + ".", request.target.identity);
  switch (request.operation) {
    case "remove-manifest":
      await target.remove(MANIFEST, { force: true });
      break;
    case "remove":
      await removeSyncedSkillPath(target, request.relativePath, assertCurrent);
      break;
    case "copy":
      await copySkillTree(
        request.source,
        request.destination,
        target,
        request.reconcile,
        assertCurrent,
      );
      break;
    case "library":
      for (const file of request.files) {
        const filePath = path.join(request.destination, file.path);
        assertCurrent();
        phase("library_directory");
        await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        assertCurrent();
        phase("library_copy");
        await target.create(
          `.${path.sep}${path.relative(request.target.directory, filePath)}`,
          Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"),
          { mode: file.executable ? 0o500 : 0o400, durable: false },
        );
      }
      break;
    case "manifest":
      await target.writeJson(MANIFEST, request.manifest, { trailingNewline: true, durable: false });
      break;
  }
  return undefined;
}

async function ensureSyncedSkillsDirectory(
  targetSkillsDir: string,
  assertCurrent?: () => void,
): Promise<void> {
  try {
    const stat = await fsp.lstat(targetSkillsDir);
    assertCurrent?.();
    if (stat.isDirectory()) {
      return;
    }
    await removePathWithinRoot({
      rootDir: path.dirname(targetSkillsDir),
      relativePath: path.basename(targetSkillsDir),
      recursive: true,
      symlinks: "unlink",
      assertBeforeMutation: assertCurrent,
    });
  } catch (error) {
    assertCurrent?.();
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  assertCurrent?.();
  await fsp.mkdir(targetSkillsDir, { recursive: true });
}

async function removeSyncedSkillPath(
  target: Root,
  relativePath: string,
  assertCurrent?: () => void,
) {
  const stat = await fsp.lstat(path.join(target.rootDir, relativePath));
  assertCurrent?.();
  if (stat.isDirectory()) {
    await ensureWritableSkillDirectories(target, relativePath, assertCurrent);
  }
  await removePathWithinRoot({
    rootDir: target.rootDir,
    relativePath,
    recursive: true,
    symlinks: "unlink",
    assertBeforeMutation: assertCurrent,
  });
  assertCurrent?.();
}

// Recursive fs.cp does not expose custody checkpoints between its internal awaits and writes.
async function copySkillTree(
  source: string,
  destination: string,
  target: Root,
  reconcile: boolean,
  assertCurrent?: () => void,
): Promise<void> {
  if (!shouldSyncSkillPath(source)) {
    return;
  }
  const stat = await fsp.lstat(source);
  const relativePath = path.relative(target.rootDir, destination);
  let destinationStat: fs.Stats | undefined;
  if (reconcile) {
    try {
      destinationStat = await fsp.lstat(destination);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  if (
    stat.isFile() &&
    destinationStat?.isFile() &&
    stat.size === destinationStat.size &&
    stat.mode === destinationStat.mode
  ) {
    // A same-size edit can share filesystem timestamps with the previous copy.
    const hashes = [
      sha256File(source, { maxBytes: stat.size }),
      sha256File(destination, { maxBytes: destinationStat.size }),
    ] as const;
    const [sourceContent, destinationContent] = await Promise.all(hashes).catch(
      async (error: unknown) => {
        // A failed sibling must not release native custody before both descriptors close.
        await Promise.allSettled(hashes);
        throw error;
      },
    );
    if (sourceContent.digest === destinationContent.digest) {
      return;
    }
  }
  if (destinationStat && !(stat.isDirectory() && destinationStat.isDirectory())) {
    await removeSyncedSkillPath(target, relativePath, assertCurrent);
    destinationStat = undefined;
  }
  if (stat.isDirectory()) {
    if (!destinationStat) {
      assertCurrent?.();
      await fsp.mkdir(destination, { mode: stat.mode | 0o700 });
    }
    await ensureWritableSkillDirectories(target, relativePath, assertCurrent, stat.mode);
    const children = await fsp.readdir(source);
    if (destinationStat) {
      const expected = new Set(
        children.filter((name) => shouldSyncSkillPath(path.join(source, name))),
      );
      const existing = await fsp.readdir(destination);
      for (const name of existing) {
        if (!expected.has(name)) {
          await removeSyncedSkillPath(target, path.join(relativePath, name), assertCurrent);
        }
      }
    }
    for (const name of children) {
      await copySkillTree(
        path.join(source, name),
        path.join(destination, name),
        target,
        reconcile,
        assertCurrent,
      );
    }
  } else if (stat.isSymbolicLink()) {
    const link = await fsp.readlink(source);
    const targetStat =
      process.platform === "win32" ? await fsp.stat(source).catch(() => undefined) : undefined;
    assertCurrent?.();
    await fsp.symlink(
      path.resolve(path.dirname(source), link),
      destination,
      targetStat?.isDirectory() ? "dir" : "file",
    );
  } else {
    // The pinned root revalidates custody after its awaits, at each mutation.
    await target.copyIn(`.${path.sep}${relativePath}`, source, {
      preserveSourceMode: true,
      sourceHardlinks: "allow",
      durable: false,
    });
  }
}
