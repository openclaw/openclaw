import { createHash } from "node:crypto";
import { closeSync, fstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openRootFile, readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import type { SupervisedWorkflowContract } from "./supervised-workflow.types.js";

export type SupervisedWorkspaceSnapshot = {
  hash: string;
  files: Array<{ path: string; sha256: string; bytes: number; executable: boolean }>;
};

/** Pin the validated regular-file descriptor, then enforce the allocation
 * bound while reading. A pre-read size check alone permits a growth race. */
export async function readSupervisedWorkspaceFile(
  workspace: string,
  relative: string,
  maxBytes: number,
) {
  const root = await fs.realpath(workspace);
  const absolutePath = path.resolve(root, relative);
  if (path.relative(root, absolutePath).split(path.sep).includes(".git")) {
    throw new Error("Workflow file cannot select Git metadata");
  }
  const opened = await openRootFile({
    rootPath: root,
    absolutePath,
    boundaryLabel: "accepted workflow workspace",
    maxBytes,
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    throw new Error("Workflow file is unavailable or exceeds its regular-file boundary");
  }
  try {
    const before = fstatSync(opened.fd);
    const bytes = await readFileDescriptorBounded(opened.fd, maxBytes);
    const after = fstatSync(opened.fd);
    if (
      before.size !== bytes.length ||
      before.nlink !== 1 ||
      after.nlink !== 1 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Workflow file changed during its bounded read");
    }
    return bytes;
  } finally {
    closeSync(opened.fd);
  }
}

export async function resolveSupervisedWorkspaceFile(
  workspace: string,
  relative: string,
): Promise<string> {
  const root = await fs.realpath(workspace);
  const candidate = path.resolve(root, relative);
  const rel = path.relative(root, candidate);
  if (
    rel.startsWith(`..${path.sep}`) ||
    rel === ".." ||
    path.isAbsolute(rel) ||
    rel.split(path.sep).includes(".git")
  ) {
    throw new Error("Workflow file escaped its accepted workspace");
  }
  const resolved = await fs.realpath(candidate);
  if (resolved !== candidate) {
    throw new Error("Workflow evidence cannot traverse symbolic links");
  }
  return resolved;
}

/** Host-captured bounded manifest; dependencies and Git metadata are not source artifacts. */
export async function captureSupervisedWorkspace(
  contract: Pick<SupervisedWorkflowContract, "workspace" | "sourcePaths">,
): Promise<SupervisedWorkspaceSnapshot> {
  const root = await fs.realpath(contract.workspace);
  const files = new Map<
    string,
    { path: string; sha256: string; bytes: number; executable: boolean }
  >();
  let total = 0;
  let directories = 0;
  const visit = async (name: string): Promise<void> => {
    const relative = path.relative(root, name).split(path.sep).join("/");
    if (relative.split("/").some((part) => part === ".git" || part === "node_modules")) {
      return;
    }
    const stat = await fs.lstat(name);
    if (stat.isSymbolicLink()) {
      throw new Error("Source snapshot contains a symbolic link");
    }
    if (stat.isDirectory()) {
      if (++directories > 20_000 || relative.split("/").length > 128) {
        throw new Error("Source snapshot exceeds directory limits");
      }
      const entries: string[] = [];
      const directory = await fs.opendir(name);
      for await (const entry of directory) {
        if (entries.length >= 20_000) {
          throw new Error("Source snapshot exceeds directory entry budget");
        }
        entries.push(entry.name);
      }
      for (const entry of entries.toSorted()) {
        await visit(path.join(name, entry));
      }
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024 || files.size >= 20_000) {
      throw new Error("Source snapshot exceeds supported regular-file limits");
    }
    if (files.has(relative)) {
      return;
    }
    total += stat.size;
    if (total > 64 * 1024 * 1024) {
      throw new Error("Source snapshot exceeds 64 MiB");
    }
    const bytes = await readSupervisedWorkspaceFile(root, relative, 8 * 1024 * 1024);
    const after = await fs.lstat(name);
    if (
      after.ino !== stat.ino ||
      after.dev !== stat.dev ||
      bytes.length !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw new Error("Source changed while capturing its manifest");
    }
    files.set(relative, {
      path: relative,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      executable: (stat.mode & 0o111) !== 0,
    });
  };
  for (const source of contract.sourcePaths) {
    await visit(await resolveSupervisedWorkspaceFile(root, source));
  }
  const entries = [...files.values()].toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    hash: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    files: entries,
  };
}
