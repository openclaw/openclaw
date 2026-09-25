import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDirectoryWithinRoot } from "@openclaw/fs-safe/advanced";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { SupervisedWorkflowDatabaseOptions as Options } from "./supervised-workflow.persistence.js";

export function supervisedWorkspaceVersionPath(version: string, options: Options = {}) {
  if (!/^[a-f0-9-]{36}$/.test(version)) {
    throw new Error("Invalid workspace version identity");
  }
  const database =
    options.database?.path ?? options.path ?? resolveOpenClawStateSqlitePath(options.env);
  // The database is already open. Resolve its configured parent, not the
  // artifact root/leaf whose independent alias rejection must remain intact.
  return path.join(realpathSync.native(path.dirname(database)), "taskflow-workspaces", version);
}

/** Establish the artifact boundary before the first directory mutation. Used by
 * the launcher and initial snapshot capture; neither may follow a store alias. */
export async function createSupervisedWorkspaceDirectory(directory: string) {
  const artifactRoot = path.dirname(directory);
  const stateRoot = path.dirname(artifactRoot);
  if (
    path.basename(artifactRoot) !== "taskflow-workspaces" ||
    !/^[a-f0-9-]{36}$/.test(path.basename(directory)) ||
    (await fs.realpath(stateRoot)) !== stateRoot
  ) {
    throw new Error("Task artifact directory must use its canonical state root");
  }
  try {
    const stat = await fs.lstat(artifactRoot);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error("Task artifact root must be a canonical private directory");
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  // The library rejects symlink segments before descending and creates private
  // components individually instead of recursive mkdir through an alias.
  const prepared = await ensureDirectoryWithinRoot({
    rootDir: stateRoot,
    requestedPath: path.relative(stateRoot, artifactRoot),
    scopeLabel: "task artifacts",
    mode: 0o700,
  });
  if (!prepared.ok) {
    throw new Error(prepared.error);
  }
  try {
    await fs.lstat(directory);
    throw new Error("Task artifact allocation already exists");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const created = await ensureDirectoryWithinRoot({
    rootDir: artifactRoot,
    requestedPath: path.basename(directory),
    scopeLabel: "task allocation",
    mode: 0o700,
  });
  if (!created.ok) {
    throw new Error(created.error);
  }
}
