import fs from "node:fs/promises";
import path from "node:path";
import { resolveRootPathSync } from "@openclaw/fs-safe/advanced";
import { isPathInside } from "@openclaw/fs-safe/path";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { pathExists, root } from "../../infra/fs-safe.js";

const ALLOWED_SUPPORT_FILE_ROOTS = new Set(
  "assets examples references scripts templates".split(" "),
);
export const MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES = 256 * 1024;

type WorkspaceSkillSupportFileWrite = { path: string; content: string };
type WorkspaceSkillSupportFileRestoration = {
  path: string;
  previousContent: string | null;
  proposedContentHash: string;
};

type SkillsRootWriteTargetParams = {
  skillsRoot: string;
  filePath: string;
};

type PreparedWorkspaceSkillFileMutation = {
  filePath: string;
  rootDir: string;
  relativePath: string;
  previousContent: string | null;
  content: string;
  proposedContentHash: string;
};

export type PreparedWorkspaceSkillMutation = {
  mode: "create" | "update";
  skillsRoot: string;
  skillDir: string;
  skillFile: PreparedWorkspaceSkillFileMutation;
  supportFiles: Array<PreparedWorkspaceSkillFileMutation & { path: string }>;
};

export function normalizeWorkspaceSkillSupportPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Support file path is required.");
  }
  if (trimmed.includes("\\")) {
    throw new Error("Support file paths must use forward slashes.");
  }
  if (path.posix.isAbsolute(trimmed)) {
    throw new Error("Support file paths must be relative.");
  }
  if (
    trimmed
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.startsWith("."))
  ) {
    throw new Error("Support file paths must use plain relative path segments.");
  }
  if (!ALLOWED_SUPPORT_FILE_ROOTS.has(trimmed.split("/")[0] ?? "")) {
    throw new Error(
      `Support file paths must be under one of: ${[...ALLOWED_SUPPORT_FILE_ROOTS].join(", ")}.`,
    );
  }
  return trimmed;
}

export function assertWorkspaceSkillSupportPathSetIsFileOnly(paths: readonly string[]): void {
  const sorted = paths.toSorted((a, b) => a.localeCompare(b));
  for (const filePath of sorted) {
    if (!filePath.includes("/")) {
      throw new Error("Support file paths must include a file below an allowed support directory.");
    }
    // A parent may not neighbor its descendant when another name sorts between them.
    const ancestor = sorted.find((candidate) => filePath.startsWith(`${candidate}/`));
    if (ancestor) {
      throw new Error(`Support file paths cannot overlap: ${ancestor} and ${filePath}`);
    }
  }
}

export async function readWorkspaceSkillFile(filePath: string): Promise<string | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }
  const skillRoot = await root(path.dirname(filePath));
  const read = await skillRoot.read(path.basename(filePath), {
    hardlinks: "reject",
    maxBytes: 1024 * 1024,
    symlinks: "reject",
  });
  return read.buffer.toString("utf8");
}

export async function readWorkspaceSupportFile(params: {
  skillDir: string;
  relativePath: string;
}): Promise<string | null> {
  return readPreparedWorkspaceFile(
    {
      rootDir: params.skillDir,
      relativePath: normalizeWorkspaceSkillSupportPath(params.relativePath),
    },
    MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
  );
}

export async function prepareWorkspaceSkillMutation(params: {
  skillsRoot: string;
  skillDir: string;
  skillFile: string;
  content: string;
  supportFiles?: readonly WorkspaceSkillSupportFileWrite[];
  mode: "create" | "update";
}): Promise<PreparedWorkspaceSkillMutation> {
  assertInsideSkillsRoot(params.skillsRoot, params.skillDir, "skill directory");
  await fs.mkdir(params.skillsRoot, { recursive: true });
  const supportFiles = normalizeSupportFiles(params.supportFiles ?? []);
  const skillTarget = await resolveSkillsRootWriteTarget({
    skillsRoot: params.skillsRoot,
    filePath: params.skillFile,
  });
  const previousContent = await readWorkspaceSkillFile(params.skillFile);
  if (params.mode === "create" && previousContent !== null) {
    throw new Error(`Target skill already exists: ${params.skillFile}`);
  }
  if (params.mode === "update" && previousContent === null) {
    throw new Error(`Target skill is missing: ${params.skillFile}`);
  }

  const preparedSupportFiles: PreparedWorkspaceSkillMutation["supportFiles"] = [];
  for (const file of supportFiles) {
    const filePath = path.join(params.skillDir, ...file.path.split("/"));
    const target = await resolveSkillsRootWriteTarget({
      skillsRoot: params.skillsRoot,
      filePath,
    });
    const previousSupportContent = await readWorkspaceSupportFile({
      skillDir: params.skillDir,
      relativePath: file.path,
    });
    if (params.mode === "create" && previousSupportContent !== null) {
      throw new Error(`Target support file already exists: ${filePath}`);
    }
    preparedSupportFiles.push({
      path: file.path,
      filePath,
      ...target,
      previousContent: previousSupportContent,
      content: file.content,
      proposedContentHash: sha256Hex(file.content),
    });
  }

  return {
    mode: params.mode,
    skillsRoot: params.skillsRoot,
    skillDir: params.skillDir,
    skillFile: {
      filePath: params.skillFile,
      ...skillTarget,
      previousContent,
      content: params.content,
      proposedContentHash: sha256Hex(params.content),
    },
    supportFiles: preparedSupportFiles,
  };
}

export async function prepareWorkspaceSkillRestoration(params: {
  skillsRoot: string;
  skillDir: string;
  skillFile: string;
  previousContent: string | null;
  proposedContentHash: string;
  supportFiles?: readonly WorkspaceSkillSupportFileRestoration[];
  mode: "create" | "update";
}): Promise<PreparedWorkspaceSkillMutation> {
  assertInsideSkillsRoot(params.skillsRoot, params.skillDir, "skill directory");
  await fs.mkdir(params.skillsRoot, { recursive: true });
  const supportFiles = (params.supportFiles ?? []).map((file) => ({
    path: normalizeWorkspaceSkillSupportPath(file.path),
    previousContent: file.previousContent,
    proposedContentHash: file.proposedContentHash,
  }));
  assertWorkspaceSkillSupportPathSetIsFileOnly(supportFiles.map((file) => file.path));
  const skillTarget = await resolveSkillsRootWriteTarget({
    skillsRoot: params.skillsRoot,
    filePath: params.skillFile,
  });
  const preparedSupportFiles: PreparedWorkspaceSkillMutation["supportFiles"] = [];
  for (const file of supportFiles) {
    const filePath = path.join(params.skillDir, ...file.path.split("/"));
    const target = await resolveSkillsRootWriteTarget({
      skillsRoot: params.skillsRoot,
      filePath,
    });
    preparedSupportFiles.push({
      path: file.path,
      filePath,
      ...target,
      previousContent: file.previousContent,
      content: file.previousContent ?? "",
      proposedContentHash: file.proposedContentHash,
    });
  }
  return {
    mode: params.mode,
    skillsRoot: params.skillsRoot,
    skillDir: params.skillDir,
    skillFile: {
      filePath: params.skillFile,
      ...skillTarget,
      previousContent: params.previousContent,
      content: params.previousContent ?? "",
      proposedContentHash: params.proposedContentHash,
    },
    supportFiles: preparedSupportFiles,
  };
}

export async function applyWorkspaceSkillMutation(
  mutation: PreparedWorkspaceSkillMutation,
  writeFile: (
    file: PreparedWorkspaceSkillFileMutation,
    overwrite: boolean,
  ) => Promise<void> = writeWorkspaceSkillFile,
): Promise<void> {
  const written: PreparedWorkspaceSkillFileMutation[] = [];
  try {
    for (const file of mutation.supportFiles) {
      await writePreparedWorkspaceFile(file, mutation.mode === "update", writeFile);
      written.push(file);
    }
    await writePreparedWorkspaceFile(mutation.skillFile, mutation.mode === "update", writeFile);
  } catch (error) {
    try {
      await restorePreparedWorkspaceFiles(written.toReversed());
    } catch (restoreError) {
      const failure = new Error(
        `Skill write failed and ${written.length} support file restoration(s) failed.`,
        { cause: error },
      );
      Object.assign(failure, { restoreError });
      throw failure;
    }
    throw error;
  }
}

export async function restoreWorkspaceSkillMutation(
  mutation: PreparedWorkspaceSkillMutation,
): Promise<void> {
  // SKILL.md is the activation marker: restore support first for updates, but
  // remove it first for failed creates so a partial new skill is not discoverable.
  const files =
    mutation.mode === "create"
      ? [mutation.skillFile, ...mutation.supportFiles.toReversed()]
      : [...mutation.supportFiles.toReversed(), mutation.skillFile];
  await restorePreparedWorkspaceFiles(files);
}

export async function isWorkspaceSkillMutationApplied(
  mutation: PreparedWorkspaceSkillMutation,
): Promise<boolean> {
  return matchesWorkspaceSkillMutation(mutation, "content");
}

async function matchesWorkspaceSkillMutation(
  mutation: PreparedWorkspaceSkillMutation,
  field: "content" | "previousContent",
): Promise<boolean> {
  const skillContent = await readPreparedWorkspaceFile(mutation.skillFile, 1024 * 1024);
  if (skillContent !== mutation.skillFile[field]) {
    return false;
  }
  for (const file of mutation.supportFiles) {
    const content = await readPreparedWorkspaceFile(file, MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES);
    if (content !== file[field]) {
      return false;
    }
  }
  return true;
}

export async function isWorkspaceSkillMutationRestored(
  mutation: PreparedWorkspaceSkillMutation,
): Promise<boolean> {
  try {
    return await matchesWorkspaceSkillMutation(mutation, "previousContent");
  } catch {
    return false;
  }
}

function normalizeSupportFiles(
  supportFiles: readonly WorkspaceSkillSupportFileWrite[],
): WorkspaceSkillSupportFileWrite[] {
  const normalized = supportFiles.map((file) => ({
    ...file,
    path: normalizeWorkspaceSkillSupportPath(file.path),
  }));
  assertWorkspaceSkillSupportPathSetIsFileOnly(normalized.map((file) => file.path));
  return normalized;
}

async function writePreparedWorkspaceFile(
  file: PreparedWorkspaceSkillFileMutation,
  overwrite: boolean,
  writeFile: (file: PreparedWorkspaceSkillFileMutation, overwrite: boolean) => Promise<void>,
): Promise<void> {
  try {
    await writeFile(file, overwrite);
  } catch (error) {
    // fs-safe commits writes atomically, but its post-write identity check can
    // reject after commit. Restore only our exact bytes; preserve external edits.
    const currentContent = await readPreparedWorkspaceFile(file, 1024 * 1024).catch(() => null);
    if (currentContent === file.content && currentContent !== file.previousContent) {
      try {
        await restorePreparedWorkspaceFiles([file]);
      } catch (restoreError) {
        const failure = new Error("Skill write failed after commit and restoration failed.", {
          cause: error,
        });
        Object.assign(failure, { restoreError });
        throw failure;
      }
    }
    throw error;
  }
}

async function writeWorkspaceSkillFile(
  file: PreparedWorkspaceSkillFileMutation,
  overwrite: boolean,
): Promise<void> {
  const targetRoot = await root(file.rootDir);
  await targetRoot.write(file.relativePath, file.content, {
    encoding: "utf8",
    mkdir: true,
    overwrite,
  });
}

async function restorePreparedWorkspaceFiles(
  files: readonly PreparedWorkspaceSkillFileMutation[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const file of files) {
    try {
      const currentContent = await readPreparedWorkspaceFile(file, 1024 * 1024);
      if (currentContent === file.previousContent) {
        continue;
      }
      if (currentContent === null || sha256Hex(currentContent) !== file.proposedContentHash) {
        throw new Error(`Workspace skill target changed before restoration: ${file.filePath}`);
      }
      const targetRoot = await root(file.rootDir);
      if (file.previousContent === null) {
        await targetRoot.remove(file.relativePath).catch((error: unknown) => {
          if ((error as { code?: string })?.code !== "ENOENT") {
            throw error;
          }
        });
      } else {
        await targetRoot.write(file.relativePath, file.previousContent, {
          encoding: "utf8",
          mkdir: true,
          overwrite: true,
        });
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to restore the previous workspace skill state.");
  }
}

async function readPreparedWorkspaceFile(
  file: Pick<PreparedWorkspaceSkillFileMutation, "rootDir" | "relativePath">,
  maxBytes: number,
): Promise<string | null> {
  if (!(await pathExists(path.join(file.rootDir, file.relativePath)))) {
    return null;
  }
  const targetRoot = await root(file.rootDir);
  const read = await targetRoot.read(file.relativePath, {
    hardlinks: "reject",
    maxBytes,
    symlinks: "reject",
  });
  return read.buffer.toString("utf8");
}

async function resolveSkillsRootWriteTarget(
  params: SkillsRootWriteTargetParams,
): Promise<{ rootDir: string; relativePath: string }> {
  assertInsideSkillsRoot(params.skillsRoot, params.filePath, "skill file");
  const skillsRoot = path.resolve(params.skillsRoot);
  const filePath = path.resolve(params.filePath);
  return { rootDir: skillsRoot, relativePath: path.relative(skillsRoot, filePath) };
}

export function assertInsideSkillsRoot(
  skillsRoot: string,
  targetPath: string,
  label: string,
): void {
  const resolvedRoot = path.resolve(skillsRoot);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget !== resolvedRoot && !isPathInside(resolvedRoot, resolvedTarget)) {
    throw new Error(`${label} must stay inside the Skill Workshop directory.`);
  }
  try {
    resolveRootPathSync({
      rootPath: resolvedRoot,
      absolutePath: resolvedTarget,
      boundaryLabel: "Skill Workshop directory",
    });
  } catch (cause) {
    throw new Error(`${label} must stay inside the Skill Workshop directory.`, { cause });
  }
}
