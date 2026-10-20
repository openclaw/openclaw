// Copies a system agent's files from the shared root into its own workspace before Doctor pins it.
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_MEMORY_FILENAME,
  GENERATED_WORKSPACE_BOOTSTRAP_FILENAMES,
  fileDiffersFromTemplate,
} from "../../../agents/workspace.js";
import { hasErrnoCode } from "../../../infra/errno.js";
import { lstatIfExists } from "../../../infra/path-existence.js";

export type WorkspaceRestorePlan = {
  /** Relative paths copied from the root; seeded template files in the target are replaced. */
  copies: string[];
  /** Relative paths of symbolic links recreated in the target, pointing where the root's do. */
  links: string[];
  /** Relative paths customized differently in both directories; the target keeps its own. */
  conflicts: string[];
};

const TEMPLATED_FILES: ReadonlySet<string> = new Set(GENERATED_WORKSPACE_BOOTSTRAP_FILENAMES);
const RESTORED_DIRS = ["memory", "skills"] as const;

async function readIfPresent(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function planFile(from: string, to: string, rel: string, plan: WorkspaceRestorePlan) {
  const templated = TEMPLATED_FILES.has(rel);
  const source = await readIfPresent(path.join(from, rel));
  if (!source || (templated && !(await fileDiffersFromTemplate(from, rel)))) {
    return;
  }
  const targetPath = path.join(to, rel);
  // A linked file in the target is kept: copying over it would write to the link's destination.
  if ((await lstatIfExists(targetPath, "ENOENT"))?.isSymbolicLink()) {
    plan.conflicts.push(rel);
    return;
  }
  const target = await readIfPresent(targetPath);
  if (!target || (templated && !(await fileDiffersFromTemplate(to, rel)))) {
    plan.copies.push(rel);
  } else if (!target.equals(source)) {
    plan.conflicts.push(rel);
  }
}

async function linkTarget(dir: string, rel: string): Promise<string | undefined> {
  const link = path.join(dir, rel);
  try {
    return path.resolve(path.dirname(link), await fs.readlink(link));
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "EINVAL")) {
      return undefined;
    }
    throw error;
  }
}

async function planLink(from: string, to: string, rel: string, plan: WorkspaceRestorePlan) {
  const source = await linkTarget(from, rel);
  if ((await lstatIfExists(path.join(to, rel), "ENOENT")) === undefined) {
    plan.links.push(rel);
  } else if (source !== (await linkTarget(to, rel))) {
    plan.conflicts.push(rel);
  }
}

async function planTree(from: string, to: string, rel: string, plan: WorkspaceRestorePlan) {
  let entries;
  try {
    entries = await fs.readdir(path.join(from, rel), { withFileTypes: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  // A linked or non-directory target is kept whole: descending would write through it.
  const target = await lstatIfExists(path.join(to, rel), "ENOENT");
  if (target && !target.isDirectory()) {
    plan.conflicts.push(rel);
    return;
  }
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      await planTree(from, to, child, plan);
    } else if (entry.isFile()) {
      await planFile(from, to, child, plan);
    } else if (entry.isSymbolicLink()) {
      await planLink(from, to, child, plan);
    }
  }
}

/**
 * Lists the persona, memory, and skill files (and links under memory/ and skills/) `from` holds
 * that `to` lacks or still has as a seed.
 */
export async function planWorkspaceRestore(
  from: string,
  to: string,
): Promise<WorkspaceRestorePlan> {
  const plan: WorkspaceRestorePlan = { copies: [], links: [], conflicts: [] };
  for (const name of [...GENERATED_WORKSPACE_BOOTSTRAP_FILENAMES, DEFAULT_MEMORY_FILENAME]) {
    await planFile(from, to, name, plan);
  }
  for (const dir of RESTORED_DIRS) {
    await planTree(from, to, dir, plan);
  }
  return plan;
}

/** Copies the planned files; the root keeps every original and no customized target is replaced. */
export async function applyWorkspaceRestore(
  from: string,
  to: string,
  plan: WorkspaceRestorePlan,
): Promise<void> {
  for (const rel of plan.copies) {
    const target = path.join(to, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // A seeded template is replaced; any other target must still be absent.
    await fs.copyFile(
      path.join(from, rel),
      target,
      TEMPLATED_FILES.has(rel) ? 0 : fs.constants.COPYFILE_EXCL,
    );
  }
  for (const rel of plan.links) {
    const source = path.join(from, rel);
    const target = path.join(to, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // An absolute target keeps a relative link pointing where it did from the root.
    await fs.symlink(path.resolve(path.dirname(source), await fs.readlink(source)), target);
  }
}
