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

type WorkspaceSkillSupportFileRestoration = {
  path: string;
  previousContent: string | null;
  proposedContentHash: string;
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

function assertWorkspaceSkillSupportPathSetIsFileOnly(paths: readonly string[]): void {
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
  return readPreparedWorkspaceFile(
    { rootDir: path.dirname(filePath), relativePath: path.basename(filePath) },
    1024 * 1024,
  );
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
  const skillTarget = resolveSkillsRootWriteTarget(params.skillsRoot, params.skillFile);
  const preparedSupportFiles: PreparedWorkspaceSkillMutation["supportFiles"] = [];
  for (const file of supportFiles) {
    const filePath = path.join(params.skillDir, ...file.path.split("/"));
    const target = resolveSkillsRootWriteTarget(params.skillsRoot, filePath);
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

function resolveSkillsRootWriteTarget(skillsRoot: string, filePath: string) {
  assertInsideSkillsRoot(skillsRoot, filePath, "skill file");
  const rootDir = path.resolve(skillsRoot);
  return { rootDir, relativePath: path.relative(rootDir, path.resolve(filePath)) };
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
