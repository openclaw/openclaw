/** Doctor checks and repairs for workspace memory files and legacy workspace hints. */
import fs from "node:fs";
import path from "node:path";
import { readRegularFile } from "@openclaw/fs-safe/advanced";
import { safeStatSync } from "@openclaw/fs-safe/path";
import { note } from "../../packages/terminal-core/src/note.js";
import { DEFAULT_AGENTS_FILENAME } from "../agents/workspace.js";
import { safeRealpathSync } from "../infra/boundary-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import { findGitRoot } from "../infra/git-root.js";
import {
  CANONICAL_ROOT_MEMORY_FILENAME,
  LEGACY_ROOT_MEMORY_FILENAME,
  resolveCanonicalRootMemoryPath,
  resolveLegacyRootMemoryPath,
  resolveRootMemoryRepairDir,
} from "../memory/root-memory-files.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

// AGENTS.md is only scanned for a memory-system reference; a small cap prevents
// a huge file from being buffered just for one regex check.
const AGENTS_MD_MAX_BYTES = 1024 * 1024;
// Root memory files are markdown journals; 8 MiB is generous while preventing
// a runaway file from OOMing the migration path.
const ROOT_MEMORY_FILE_MAX_BYTES = 8 * 1024 * 1024;

export const MEMORY_SYSTEM_PROMPT = [
  "Memory system not found in workspace.",
  "Paste this into your agent:",
  "",
  "Install the memory system by applying:",
  "https://github.com/openclaw/openclaw/commit/9ffea23f31ca1df5183b25668f8f814bee0fb34e",
  "https://github.com/openclaw/openclaw/commit/7d1fee70e76f2f634f1b41fca927ee663914183a",
].join("\n");

/** Returns the workspace git-backup tip when the workspace exists but is not a git repo. */
export function collectWorkspaceBackupTip(workspaceDir: string): string | null {
  if (!safeStatSync(workspaceDir)?.isDirectory()) {
    return null;
  }
  const resolvedWorkspaceDir = safeRealpathSync(workspaceDir);
  if (!resolvedWorkspaceDir || findGitRoot(resolvedWorkspaceDir)) {
    return null;
  }
  return "- Tip: back up the agent workspace in a private git repo; keep ~/.openclaw out of git (credentials, sessions). Details: /concepts/agent-workspace#git-backup-recommended-private";
}

export async function shouldSuggestMemorySystem(workspaceDir: string): Promise<boolean> {
  const entries = await listWorkspaceEntries(workspaceDir);
  if (entries.has(CANONICAL_ROOT_MEMORY_FILENAME)) {
    try {
      const stat = await fs.promises.stat(resolveCanonicalRootMemoryPath(workspaceDir));
      if (stat.isFile()) {
        return false;
      }
    } catch {
      // keep scanning
    }
  }

  const agentsPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
  try {
    // Workspace instruction files may intentionally be symlinked. Resolve the
    // final target first, then keep the descriptor-backed read bounded.
    const resolvedAgentsPath = await fs.promises.realpath(agentsPath);
    const { buffer } = await readRegularFile({
      filePath: resolvedAgentsPath,
      maxBytes: AGENTS_MD_MAX_BYTES,
    });
    if (
      new RegExp(`\\b${CANONICAL_ROOT_MEMORY_FILENAME.replace(".", "\\.")}\\b`).test(
        buffer.toString("utf-8"),
      )
    ) {
      return false;
    }
  } catch {
    // no AGENTS.md or unreadable; treat as missing memory guidance
  }

  return true;
}

async function statIfExists(filePath: string) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? { exists: true, bytes: stat.size } : { exists: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

async function listWorkspaceEntries(workspaceDir: string): Promise<Set<string>> {
  try {
    return new Set(await fs.promises.readdir(workspaceDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return new Set<string>();
    }
    throw err;
  }
}

async function detectRootMemoryFiles(workspaceDir: string) {
  const resolvedWorkspace = path.resolve(workspaceDir);
  const canonicalPath = resolveCanonicalRootMemoryPath(resolvedWorkspace);
  const legacyPath = resolveLegacyRootMemoryPath(resolvedWorkspace);
  const entries = await listWorkspaceEntries(resolvedWorkspace);
  const inspect = (filePath: string): ReturnType<typeof statIfExists> =>
    entries.has(path.basename(filePath))
      ? statIfExists(filePath)
      : Promise.resolve({ exists: false });
  const [canonical, legacy] = await Promise.all([inspect(canonicalPath), inspect(legacyPath)]);
  return {
    workspaceDir: resolvedWorkspace,
    canonicalPath,
    legacyPath,
    canonicalExists: canonical.exists,
    legacyExists: legacy.exists,
    ...(typeof canonical.bytes === "number" ? { canonicalBytes: canonical.bytes } : {}),
    ...(typeof legacy.bytes === "number" ? { legacyBytes: legacy.bytes } : {}),
  };
}

function formatBytes(bytes?: number): string {
  return typeof bytes === "number" ? `${bytes} bytes` : "size unknown";
}

type RootMemoryMigrationResult = {
  changed: boolean;
  canonicalPath: string;
  legacyPath: string;
  mergedLegacy: boolean;
  archivedLegacyPath?: string;
  /** True when the repair was skipped because a file exceeded the safe read limit. */
  readLimitExceeded?: boolean;
  /** True when the repair was skipped because a file could not be read. */
  readError?: boolean;
  /** True when the legacy file could not be archived atomically. */
  archiveError?: boolean;
};

async function moveLegacyRootMemoryFileToArchive(params: {
  workspaceDir: string;
  legacyPath: string;
}): Promise<string> {
  const repairDir = resolveRootMemoryRepairDir(params.workspaceDir);
  await fs.promises.mkdir(repairDir, { recursive: true });
  const archiveDir = path.join(
    repairDir,
    new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"),
  );
  await fs.promises.mkdir(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, LEGACY_ROOT_MEMORY_FILENAME);
  // Source and repair archive live under one workspace. If a mounted file makes
  // this cross-device, fail before mutation instead of copying an unbounded file.
  await fs.promises.rename(params.legacyPath, archivePath);
  return archivePath;
}

function buildMergedLegacyRootMemorySection(params: {
  legacyText: string;
  archivedLegacyPath: string;
}): string {
  return [
    "",
    `## Imported From Legacy Root ${LEGACY_ROOT_MEMORY_FILENAME}`,
    "",
    `<!-- openclaw-root-memory-merge source=${LEGACY_ROOT_MEMORY_FILENAME} archived=${params.archivedLegacyPath} -->`,
    `This content came from legacy root \`${LEGACY_ROOT_MEMORY_FILENAME}\`, which was shadowed by \`${CANONICAL_ROOT_MEMORY_FILENAME}\`.`,
    "",
    params.legacyText.trim(),
    "",
  ].join("\n");
}

/** Archives and merges a legacy root memory file into canonical memory. */
async function migrateLegacyRootMemoryFile(
  workspaceDir: string,
): Promise<RootMemoryMigrationResult> {
  const detection = await detectRootMemoryFiles(workspaceDir);
  const unchanged: RootMemoryMigrationResult = {
    changed: false,
    canonicalPath: detection.canonicalPath,
    legacyPath: detection.legacyPath,
    mergedLegacy: false,
  };
  if (!detection.canonicalExists || !detection.legacyExists) {
    return unchanged;
  }
  const skippedForReadFailure = (err: unknown): RootMemoryMigrationResult => {
    const isTooLarge =
      typeof err === "object" &&
      err !== null &&
      "message" in err &&
      typeof (err as Error).message === "string" &&
      (err as Error).message.startsWith("File exceeds");
    return {
      ...unchanged,
      readLimitExceeded: isTooLarge,
      readError: !isTooLarge,
    };
  };
  const readMemoryFile = (filePath: string) =>
    readRegularFile({ filePath, maxBytes: ROOT_MEMORY_FILE_MAX_BYTES });
  try {
    // Reject oversized, unreadable, symlinked, or non-regular inputs before the
    // archive rename. The archived snapshot is read again after the atomic move.
    await Promise.all([
      readMemoryFile(detection.canonicalPath),
      readMemoryFile(detection.legacyPath),
    ]);
  } catch (err) {
    return skippedForReadFailure(err);
  }
  let archivedLegacyPath: string;
  try {
    archivedLegacyPath = await moveLegacyRootMemoryFileToArchive({
      workspaceDir: detection.workspaceDir,
      legacyPath: detection.legacyPath,
    });
  } catch {
    return { ...unchanged, archiveError: true };
  }
  let canonicalText: string;
  let legacyText: string;
  try {
    [canonicalText, legacyText] = await Promise.all([
      readMemoryFile(detection.canonicalPath).then(({ buffer }) => buffer.toString("utf-8")),
      readMemoryFile(archivedLegacyPath).then(({ buffer }) => buffer.toString("utf-8")),
    ]);
  } catch (err) {
    const skipped = skippedForReadFailure(err);
    // The archive is the independent recovery copy. Do not link or copy it
    // back into the live path: linking lets later in-place writes corrupt the
    // archive, while copying a concurrently growing file would reintroduce an
    // unbounded read. A concurrent replacement at legacyPath stays untouched.
    return {
      ...skipped,
      changed: true,
      archivedLegacyPath,
    };
  }
  if (canonicalText !== legacyText) {
    const merged = `${canonicalText.trimEnd()}\n${buildMergedLegacyRootMemorySection({
      legacyText,
      archivedLegacyPath: shortenHomePath(archivedLegacyPath),
    })}`;
    await fs.promises.writeFile(detection.canonicalPath, merged, "utf-8");
  }
  return {
    ...unchanged,
    changed: true,
    mergedLegacy: canonicalText !== legacyText,
    archivedLegacyPath,
  };
}

type WorkspaceMemoryDoctorScope = {
  agentId: string;
  workspaceDir: string;
  labelAgent: boolean;
};

export async function noteWorkspaceMemoryHealth(scope: WorkspaceMemoryDoctorScope): Promise<void> {
  try {
    const detection = await detectRootMemoryFiles(scope.workspaceDir);
    if (detection.canonicalExists && detection.legacyExists) {
      const rootMemoryWarning = [
        "Split root durable memory files detected:",
        `- current: ${shortenHomePath(detection.canonicalPath)} (${formatBytes(detection.canonicalBytes)})`,
        `- legacy: ${shortenHomePath(detection.legacyPath)} (${formatBytes(detection.legacyBytes)})`,
        `OpenClaw uses ${CANONICAL_ROOT_MEMORY_FILENAME} as the current durable memory file.`,
        `Dreaming writes durable promotions to ${CANONICAL_ROOT_MEMORY_FILENAME}, so older facts in ${LEGACY_ROOT_MEMORY_FILENAME} can be shadowed.`,
        `Run "openclaw doctor --fix" to merge the legacy file into ${CANONICAL_ROOT_MEMORY_FILENAME} with a backup.`,
      ].join("\n");
      note(
        `${scope.labelAgent ? `Agent "${scope.agentId}":\n` : ""}${rootMemoryWarning}`,
        "Workspace memory",
      );
    }
  } catch (err) {
    const prefix = scope.labelAgent ? `Agent "${scope.agentId}": ` : "";
    note(
      `${prefix}Workspace memory audit could not be completed: ${formatErrorMessage(err)}`,
      "Doctor",
    );
  }
}

/** Prompts to merge legacy root memory into canonical memory when both files exist. */
export async function maybeRepairWorkspaceMemoryHealth(params: {
  prompter: DoctorPrompter;
  scope: WorkspaceMemoryDoctorScope;
}): Promise<void> {
  try {
    const prefix = params.scope.labelAgent ? `Agent "${params.scope.agentId}": ` : "";
    const rootMemoryFiles = await detectRootMemoryFiles(params.scope.workspaceDir);
    if (!rootMemoryFiles.canonicalExists || !rootMemoryFiles.legacyExists) {
      return;
    }
    const approvedLegacyMigration = await params.prompter.confirmRuntimeRepair({
      message: `${prefix}Merge legacy root ${LEGACY_ROOT_MEMORY_FILENAME} into the current ${CANONICAL_ROOT_MEMORY_FILENAME} and remove the shadowed file?`,
      initialValue: true,
    });
    if (!approvedLegacyMigration) {
      return;
    }
    const migration = await migrateLegacyRootMemoryFile(params.scope.workspaceDir);
    const reason = migration.readLimitExceeded
      ? "a file exceeded the safe read limit"
      : migration.readError
        ? "a file could not be read"
        : migration.archiveError
          ? "legacy memory could not be archived atomically"
          : null;
    if (reason) {
      note(
        [
          `${prefix}Workspace memory root repair skipped (${reason}):`,
          `- current: ${migration.canonicalPath}`,
          `- legacy: ${migration.legacyPath}`,
          migration.archivedLegacyPath
            ? `- preserved archive: ${migration.archivedLegacyPath}`
            : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        "Doctor changes",
      );
      return;
    }
    if (!migration.changed) {
      return;
    }
    const lines = [
      `${prefix}Workspace memory root merged:`,
      `- current: ${migration.canonicalPath}`,
      migration.archivedLegacyPath ? `- backup: ${migration.archivedLegacyPath}` : null,
      migration.mergedLegacy ? `- merged legacy content from: ${migration.legacyPath}` : null,
      `- removed legacy file: ${migration.legacyPath}`,
    ].filter(Boolean);
    note(lines.join("\n"), "Doctor changes");
  } catch (err) {
    const prefix = params.scope.labelAgent ? `Agent "${params.scope.agentId}": ` : "";
    note(
      `${prefix}Workspace memory repair could not be completed: ${formatErrorMessage(err)}`,
      "Doctor",
    );
  }
}
