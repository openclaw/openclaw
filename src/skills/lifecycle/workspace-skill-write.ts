import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { FsSafeError, pathExists, root } from "../../infra/fs-safe.js";
import { isSymlinkOpenError } from "../../infra/path-guards.js";
import { isPathInside } from "../../infra/path-safety.js";
import { findContainingAllowedSkillSymlinkTarget } from "../loading/symlink-targets.js";

const ALLOWED_SUPPORT_FILE_ROOTS = new Set(
  "assets examples references scripts templates".split(" "),
);
export const MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES = 256 * 1024;

type WorkspaceSkillSymlinkWritePolicy = {
  allowWrites: boolean;
  allowedTargetRealPaths: readonly string[];
};
type WorkspaceSkillSupportFileWrite = { path: string; content: string };
type WorkspaceSkillSupportFileRestoration = {
  path: string;
  previousContent: string | null;
  proposedContentHash: string;
};

type WorkspaceSkillWriteTargetParams = {
  workspaceDir: string;
  filePath: string;
  symlinkPolicy: WorkspaceSkillSymlinkWritePolicy;
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
  workspaceDir: string;
  skillDir: string;
  skillFile: PreparedWorkspaceSkillFileMutation;
  supportFiles: Array<PreparedWorkspaceSkillFileMutation & { path: string }>;
};

export function normalizeWorkspaceSkillSupportPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Support file path is required.");
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed)) {
    throw new Error("Support file paths cannot contain control or formatting characters.");
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
  if (trimmed === "PROPOSAL.md" || trimmed === "SKILL.md") {
    throw new Error("Support files cannot replace the proposal or skill markdown file.");
  }
  return trimmed;
}

export function assertWorkspaceSkillSupportPathSetIsFileOnly(paths: readonly string[]): void {
  const sorted = paths.toSorted((a, b) => a.localeCompare(b));
  for (const filePath of sorted) {
    if (!filePath.includes("/")) {
      throw new Error("Support file paths must include a file below an allowed support directory.");
    }
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous && current?.startsWith(`${previous}/`)) {
      throw new Error(`Support file paths cannot overlap: ${previous} and ${current}`);
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
    nonBlockingRead: true,
    symlinks: "reject",
  });
  return read.buffer.toString("utf8");
}

export async function readWorkspaceSupportFile(params: {
  skillDir: string;
  relativePath: string;
}): Promise<string | null> {
  const relativePath = normalizeWorkspaceSkillSupportPath(params.relativePath);
  if (!(await pathExists(path.join(params.skillDir, ...relativePath.split("/"))))) {
    return null;
  }
  const skillRoot = await root(params.skillDir);
  const read = await skillRoot.read(relativePath, {
    hardlinks: "reject",
    maxBytes: MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
    nonBlockingRead: true,
    symlinks: "reject",
  });
  return read.buffer.toString("utf8");
}

export async function assertWorkspaceSkillWriteTarget(
  params: WorkspaceSkillWriteTargetParams,
): Promise<void> {
  await resolveWorkspaceSkillWriteTarget(params);
}

export async function prepareWorkspaceSkillMutation(params: {
  workspaceDir: string;
  skillDir: string;
  skillFile: string;
  content: string;
  supportFiles?: readonly WorkspaceSkillSupportFileWrite[];
  mode: "create" | "update";
  symlinkPolicy: WorkspaceSkillSymlinkWritePolicy;
}): Promise<PreparedWorkspaceSkillMutation> {
  assertInsideWorkspace(params.workspaceDir, params.skillDir, "skill directory");
  const supportFiles = normalizeSupportFiles(params.supportFiles ?? []);
  const skillTarget = await resolveWorkspaceSkillWriteTarget({
    workspaceDir: params.workspaceDir,
    filePath: params.skillFile,
    symlinkPolicy: params.symlinkPolicy,
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
    const target = await resolveWorkspaceSkillWriteTarget({
      workspaceDir: params.workspaceDir,
      filePath,
      symlinkPolicy: params.symlinkPolicy,
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
    workspaceDir: params.workspaceDir,
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
  workspaceDir: string;
  skillDir: string;
  skillFile: string;
  previousContent: string | null;
  proposedContentHash: string;
  supportFiles?: readonly WorkspaceSkillSupportFileRestoration[];
  mode: "create" | "update";
  symlinkPolicy: WorkspaceSkillSymlinkWritePolicy;
}): Promise<PreparedWorkspaceSkillMutation> {
  assertInsideWorkspace(params.workspaceDir, params.skillDir, "skill directory");
  const supportFiles = (params.supportFiles ?? []).map((file) => ({
    path: normalizeWorkspaceSkillSupportPath(file.path),
    previousContent: file.previousContent,
    proposedContentHash: file.proposedContentHash,
  }));
  assertWorkspaceSkillSupportPathSetIsFileOnly(supportFiles.map((file) => file.path));
  const skillTarget = await resolveWorkspaceSkillWriteTarget({
    workspaceDir: params.workspaceDir,
    filePath: params.skillFile,
    symlinkPolicy: params.symlinkPolicy,
  });
  const preparedSupportFiles: PreparedWorkspaceSkillMutation["supportFiles"] = [];
  for (const file of supportFiles) {
    const filePath = path.join(params.skillDir, ...file.path.split("/"));
    const target = await resolveWorkspaceSkillWriteTarget({
      workspaceDir: params.workspaceDir,
      filePath,
      symlinkPolicy: params.symlinkPolicy,
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
    workspaceDir: params.workspaceDir,
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
  const writtenSupportPaths: string[] = [];
  try {
    for (const file of mutation.supportFiles) {
      await writePreparedWorkspaceFile(file, mutation.mode === "update", writeFile);
      written.push(file);
      writtenSupportPaths.push(file.path);
    }
    await writePreparedWorkspaceFile(mutation.skillFile, mutation.mode === "update", writeFile);
  } catch (error) {
    try {
      await restorePreparedWorkspaceFiles(written.toReversed());
    } catch (restoreError) {
      const failure = new Error(
        `Skill write failed and ${writtenSupportPaths.length} support file restoration(s) failed.`,
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
  const skillContent = await readPreparedWorkspaceFile(mutation.skillFile, 1024 * 1024);
  if (skillContent !== mutation.skillFile.content) {
    return false;
  }
  for (const file of mutation.supportFiles) {
    const content = await readPreparedWorkspaceFile(file, MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES);
    if (content !== file.content) {
      return false;
    }
  }
  return true;
}

export async function isWorkspaceSkillMutationRestored(
  mutation: PreparedWorkspaceSkillMutation,
): Promise<boolean> {
  try {
    const skillContent = await readPreparedWorkspaceFile(mutation.skillFile, 1024 * 1024);
    if (skillContent !== mutation.skillFile.previousContent) {
      return false;
    }
    for (const file of mutation.supportFiles) {
      const content = await readPreparedWorkspaceFile(file, MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES);
      if (content !== file.previousContent) {
        return false;
      }
    }
    return true;
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
  file: PreparedWorkspaceSkillFileMutation,
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

async function resolveWorkspaceSkillWriteTarget(
  params: WorkspaceSkillWriteTargetParams,
): Promise<{ rootDir: string; relativePath: string }> {
  assertInsideWorkspace(params.workspaceDir, params.filePath, "skill file");
  const workspaceDir = path.resolve(params.workspaceDir);
  const filePath = path.resolve(params.filePath);
  const aliasTarget = await resolveWorkspaceAliasTarget({ workspaceDir, filePath });
  if (!aliasTarget) {
    return { rootDir: workspaceDir, relativePath: path.relative(workspaceDir, filePath) };
  }
  const allowedRoot = params.symlinkPolicy.allowWrites
    ? findContainingAllowedSkillSymlinkTarget(
        params.symlinkPolicy.allowedTargetRealPaths,
        aliasTarget.realTarget,
      )
    : null;
  if (!allowedRoot) {
    throw new FsSafeError(
      "symlink",
      `Skill file resolves through an untrusted symlink target: ${params.filePath}. Configure skills.load.allowSymlinkTargets and enable skills.workshop.allowSymlinkTargetWrites for intentional Skill Workshop symlink writes.`,
    );
  }
  return {
    rootDir: allowedRoot,
    relativePath: path.relative(allowedRoot, aliasTarget.realTarget),
  };
}

async function resolveWorkspaceAliasTarget(params: {
  workspaceDir: string;
  filePath: string;
}): Promise<{ realTarget: string } | null> {
  const workspaceRealPath = (await tryRealpath(params.workspaceDir)) ?? params.workspaceDir;
  const realTarget = await resolveRealPathThroughExistingAncestors(
    params.workspaceDir,
    params.filePath,
  );
  return isPathInside(workspaceRealPath, realTarget) ? null : { realTarget };
}

async function resolveRealPathThroughExistingAncestors(
  workspaceDir: string,
  filePath: string,
): Promise<string> {
  const segments = path.relative(workspaceDir, filePath).split(path.sep).filter(Boolean);
  let lexicalCursor = workspaceDir;
  let realCursor = (await tryRealpath(workspaceDir)) ?? workspaceDir;
  for (const [index, segment] of segments.entries()) {
    lexicalCursor = path.join(lexicalCursor, segment);
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(lexicalCursor);
    } catch (error) {
      if (isSymlinkOpenError(error)) {
        throw invalidSkillWriteTargetSymlink(lexicalCursor, error);
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") {
        throw invalidSkillWriteTargetAncestor(lexicalCursor, error);
      }
      if (code !== "ENOENT") {
        throw error;
      }
      let unresolvedStats: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        unresolvedStats = await fs.lstat(lexicalCursor);
      } catch (lstatError) {
        const lstatCode = (lstatError as NodeJS.ErrnoException).code;
        if (lstatCode === "ENOTDIR") {
          throw invalidSkillWriteTargetAncestor(lexicalCursor, lstatError);
        }
        if (lstatCode !== "ENOENT") {
          throw lstatError;
        }
        return path.resolve(realCursor, ...segments.slice(index));
      }
      const unresolvedSymlink = unresolvedStats.isSymbolicLink();
      throw new FsSafeError(
        unresolvedSymlink ? "symlink" : "path-mismatch",
        unresolvedSymlink
          ? `Skill file path contains an unresolved symlink: ${lexicalCursor}.`
          : `Skill file path changed during validation: ${lexicalCursor}.`,
        { cause: error },
      );
    }
    const isTarget = index === segments.length - 1;
    if (!isTarget && !stats.isDirectory()) {
      throw invalidSkillWriteTargetAncestor(lexicalCursor);
    }
    if (isTarget && !stats.isFile()) {
      throw new FsSafeError(
        "not-file",
        `Skill file path is not writable as a regular file: ${lexicalCursor}.`,
      );
    }
    try {
      realCursor = await fs.realpath(lexicalCursor);
    } catch (error) {
      if (isSymlinkOpenError(error)) {
        throw invalidSkillWriteTargetSymlink(lexicalCursor, error);
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new FsSafeError(
          "path-mismatch",
          `Skill file path changed during validation: ${lexicalCursor}.`,
          { cause: error },
        );
      }
      throw error;
    }
  }
  return path.resolve(realCursor);
}

function invalidSkillWriteTargetAncestor(filePath: string, cause?: unknown): FsSafeError {
  return new FsSafeError("not-file", `Skill file path has a non-directory ancestor: ${filePath}.`, {
    cause,
  });
}

function invalidSkillWriteTargetSymlink(filePath: string, cause: unknown): FsSafeError {
  return new FsSafeError("symlink", `Skill file path contains an invalid symlink: ${filePath}.`, {
    cause,
  });
}

async function tryRealpath(filePath: string): Promise<string | null> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return null;
  }
}

export function assertInsideWorkspace(
  workspaceDir: string,
  targetPath: string,
  label: string,
): void {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedWorkspaceDir &&
    !isPathInside(resolvedWorkspaceDir, resolvedTarget)
  ) {
    throw new Error(`${label} must stay inside the workspace.`);
  }
}
