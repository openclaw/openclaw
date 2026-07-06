import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isExplicitOpenClawHomeStateDir,
  NEW_STATE_DIRNAME,
  resolveStateDir,
} from "../config/paths.js";

type OpenClawHomeStateRepairResult = {
  changes: string[];
  warnings: string[];
};

type PathPresence =
  | { kind: "missing" }
  | { kind: "file" }
  | { kind: "directory" }
  | { kind: "error"; error: unknown };

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function inspectPath(filePath: string): Promise<PathPresence> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isDirectory() ? { kind: "directory" } : { kind: "file" };
  } catch (error) {
    return isMissingPathError(error) ? { kind: "missing" } : { kind: "error", error };
  }
}

async function removeDirIfEmpty(dir: string, warnings: string[]): Promise<void> {
  try {
    if ((await fs.readdir(dir)).length === 0) {
      await fs.rmdir(dir);
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      warnings.push(`Could not remove empty nested state path ${dir}: ${String(error)}`);
    }
  }
}

async function recoverNestedStateEntry(params: {
  sourcePath: string;
  destinationPath: string;
  relativePath: string;
  conflicts: string[];
  warnings: string[];
}): Promise<number> {
  const source = await inspectPath(params.sourcePath);
  if (source.kind === "missing") {
    return 0;
  }
  if (source.kind === "error") {
    params.warnings.push(
      `Could not inspect nested state entry ${params.sourcePath}: ${String(source.error)}`,
    );
    return 0;
  }

  const destination = await inspectPath(params.destinationPath);
  if (destination.kind === "missing") {
    try {
      await fs.rename(params.sourcePath, params.destinationPath);
      return 1;
    } catch (error) {
      params.warnings.push(
        `Could not recover nested state entry ${params.sourcePath}: ${String(error)}`,
      );
      return 0;
    }
  }
  if (destination.kind === "error") {
    params.warnings.push(
      `Could not inspect nested state destination ${params.destinationPath}: ${String(destination.error)}`,
    );
    return 0;
  }
  if (source.kind !== "directory" || destination.kind !== "directory") {
    params.conflicts.push(params.relativePath);
    return 0;
  }

  let childEntries: string[];
  try {
    childEntries = (await fs.readdir(params.sourcePath)).toSorted();
  } catch (error) {
    params.warnings.push(`Could not read nested state path ${params.sourcePath}: ${String(error)}`);
    return 0;
  }

  let movedEntries = 0;
  for (const childEntry of childEntries) {
    movedEntries += await recoverNestedStateEntry({
      sourcePath: path.join(params.sourcePath, childEntry),
      destinationPath: path.join(params.destinationPath, childEntry),
      relativePath: `${params.relativePath}/${childEntry}`,
      conflicts: params.conflicts,
      warnings: params.warnings,
    });
  }
  await removeDirIfEmpty(params.sourcePath, params.warnings);
  return movedEntries;
}

export async function repairNestedOpenClawHomeStateDir(
  params: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  } = {},
): Promise<OpenClawHomeStateRepairResult> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const changes: string[] = [];
  const warnings: string[] = [];

  if (env.OPENCLAW_STATE_DIR?.trim()) {
    return { changes, warnings };
  }

  const stateDir = resolveStateDir(env, homedir);
  if (!isExplicitOpenClawHomeStateDir(env, stateDir)) {
    return { changes, warnings };
  }

  const nestedDir = path.join(stateDir, NEW_STATE_DIRNAME);
  let nestedStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    nestedStat = await fs.lstat(nestedDir);
  } catch (error) {
    if (!isMissingPathError(error)) {
      warnings.push(`Could not inspect nested state path ${nestedDir}: ${String(error)}`);
    }
    return { changes, warnings };
  }

  if (!nestedStat.isDirectory()) {
    warnings.push(`Nested state path is not a directory; left unchanged: ${nestedDir}`);
    return { changes, warnings };
  }

  let entries: string[];
  try {
    entries = (await fs.readdir(nestedDir)).toSorted();
  } catch (error) {
    warnings.push(`Could not read nested state path ${nestedDir}: ${String(error)}`);
    return { changes, warnings };
  }

  const conflicts: string[] = [];
  let movedEntries = 0;
  for (const entry of entries) {
    movedEntries += await recoverNestedStateEntry({
      sourcePath: path.join(nestedDir, entry),
      destinationPath: path.join(stateDir, entry),
      relativePath: entry,
      conflicts,
      warnings,
    });
  }

  if (movedEntries > 0) {
    changes.push(
      `Recovered ${movedEntries} nested state ${movedEntries === 1 ? "entry" : "entries"}: ${nestedDir} → ${stateDir}`,
    );
  }
  if (conflicts.length > 0) {
    warnings.push(`Nested state conflicts left unchanged in ${nestedDir}: ${conflicts.join(", ")}`);
  }

  await removeDirIfEmpty(nestedDir, warnings);

  return { changes, warnings };
}
