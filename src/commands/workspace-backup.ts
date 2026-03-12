import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { detectPreferredCloudDriveTarget } from "../backup/snapshot-store/targets.js";
import {
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveStateDir,
  writeConfigFile,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { pathExists, resolveUserPath, shortenHomePath } from "../utils.js";
import { encodeAbsolutePathForBackupArchive } from "./backup-shared.js";
import { collectWorkspaceDirs, isPathWithin } from "./cleanup-utils.js";

const WORKSPACE_BACKUP_SCHEMA_VERSION = 2;

type WorkspaceBackupStatusFile = {
  schemaVersion: 2;
  updatedAt: string;
  workspaces: Array<{
    sourcePath: string;
  }>;
};

export type WorkspaceBackupInitOptions = {
  target?: string;
  json?: boolean;
};

export type WorkspaceBackupInitResult = {
  target: string;
  detected?: string;
  updatedConfig: boolean;
};

export type WorkspaceBackupRunOptions = {
  json?: boolean;
};

export type WorkspaceBackupRunResult = {
  target: string;
  updatedAt: string;
  workspaceCount: number;
  workspaces: Array<{
    sourcePath: string;
    backupPath: string;
  }>;
};

export type WorkspaceBackupStatusResult = {
  configured: boolean;
  target?: string;
  detected?: string;
  lastUpdatedAt?: string;
  workspaceCount: number;
};

function resolveBackupConfigTarget(cfg: OpenClawConfig | undefined): string | undefined {
  const configured = cfg?.backup?.target?.trim();
  return configured ? resolveUserPath(configured) : undefined;
}

function workspaceBackupRoot(target: string): string {
  return path.join(target, "workspace");
}

function workspaceMirrorRoot(target: string): string {
  return path.join(workspaceBackupRoot(target), "mirrors");
}

function workspaceStatusPath(target: string): string {
  return path.join(workspaceBackupRoot(target), "status.json");
}

function expectedMirrorPath(mirrorRoot: string, sourcePath: string): string {
  return path.join(mirrorRoot, encodeAbsolutePathForBackupArchive(sourcePath));
}

async function canonicalizePathForContainment(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  const suffix: string[] = [];
  let probe = resolved;
  while (true) {
    try {
      const real = await fs.realpath(probe);
      return suffix.length === 0 ? real : path.join(real, ...suffix.toReversed());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        return resolved;
      }
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

async function assertPathContainedWithinRoot(
  childPath: string,
  rootPath: string,
  label: string,
): Promise<void> {
  const canonicalChild = await canonicalizePathForContainment(childPath);
  const canonicalRoot = await canonicalizePathForContainment(rootPath);
  if (!isPathWithin(canonicalChild, canonicalRoot)) {
    throw new Error(`Refusing to ${label} outside ${shortenHomePath(rootPath)}.`);
  }
}

async function readWorkspaceBackupStatus(
  target: string,
): Promise<WorkspaceBackupStatusFile | undefined> {
  try {
    const raw = await fs.readFile(workspaceStatusPath(target), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const updatedAt =
      "updatedAt" in parsed && typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;
    const workspaces = Array.isArray((parsed as { workspaces?: unknown }).workspaces)
      ? (parsed as { workspaces: unknown[] }).workspaces.flatMap((entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "sourcePath" in entry &&
          typeof entry.sourcePath === "string"
            ? [{ sourcePath: entry.sourcePath }]
            : [],
        )
      : [];
    if (!updatedAt) {
      return undefined;
    }
    return {
      schemaVersion: WORKSPACE_BACKUP_SCHEMA_VERSION,
      updatedAt,
      workspaces,
    };
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
}

async function replaceDirectoryAtomically(sourcePath: string, targetPath: string): Promise<void> {
  const rollbackPath = `${targetPath}.${randomUUID()}.bak`;
  const targetExists = await pathExists(targetPath);
  if (targetExists) {
    await fs.rename(targetPath, rollbackPath);
  }
  try {
    await fs.rename(sourcePath, targetPath);
    if (targetExists) {
      await fs.rm(rollbackPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (targetExists) {
      await fs.rename(rollbackPath, targetPath).catch(() => undefined);
    }
    throw error;
  }
}

async function assertWorkspaceBackupSafety(
  target: string,
  stateDir: string,
  workspaceDirs: readonly string[],
): Promise<void> {
  const canonicalTarget = await canonicalizePathForContainment(target);
  const canonicalStateDir = await canonicalizePathForContainment(stateDir);
  const canonicalWorkspaceBackupRoot = await canonicalizePathForContainment(
    workspaceBackupRoot(target),
  );
  if (isPathWithin(canonicalTarget, canonicalStateDir)) {
    throw new Error("backup.target must not be inside the live state directory.");
  }
  for (const workspaceDir of workspaceDirs) {
    const canonicalWorkspaceDir = await canonicalizePathForContainment(workspaceDir);
    if (isPathWithin(canonicalTarget, canonicalWorkspaceDir)) {
      throw new Error(
        `backup.target must not live inside a workspace being mirrored: ${shortenHomePath(workspaceDir)}`,
      );
    }
    if (isPathWithin(canonicalWorkspaceDir, canonicalWorkspaceBackupRoot)) {
      throw new Error(
        `workspace path must not be inside backup.target/workspace: ${shortenHomePath(workspaceDir)}`,
      );
    }
  }
}

async function resolveWorkspaceBackupState(): Promise<{
  target: string;
  workspaceDirs: string[];
  stateDir: string;
}> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    throw new Error("Config is invalid. Workspace backup commands require a valid config file.");
  }
  const target = resolveBackupConfigTarget(snapshot.config);
  if (!target) {
    throw new Error("backup.target is not configured. Run `openclaw backup setup` first.");
  }
  const workspaceDirs = collectWorkspaceDirs(snapshot.config);
  const stateDir = resolveStateDir();
  await assertWorkspaceBackupSafety(target, stateDir, workspaceDirs);
  return {
    target,
    workspaceDirs,
    stateDir,
  };
}

export async function workspaceBackupInitCommand(
  runtime: RuntimeEnv,
  opts: WorkspaceBackupInitOptions,
): Promise<WorkspaceBackupInitResult> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    throw new Error("Config is invalid. Fix the config before initializing workspace backup.");
  }

  const configuredTarget = resolveBackupConfigTarget(snapshot.resolved);
  const explicitTarget = opts.target?.trim() ? resolveUserPath(opts.target) : undefined;
  const detected =
    !explicitTarget && !configuredTarget ? await detectPreferredCloudDriveTarget() : undefined;
  const target = explicitTarget ?? configuredTarget ?? detected?.targetDir;
  if (!target) {
    throw new Error(
      "Could not detect a cloud drive folder automatically. Pass --target to choose a backup directory.",
    );
  }

  await assertWorkspaceBackupSafety(
    target,
    resolveStateDir(),
    collectWorkspaceDirs(snapshot.config),
  );
  await fs.mkdir(target, { recursive: true });
  const nextConfig: OpenClawConfig = {
    ...snapshot.resolved,
    backup: {
      ...snapshot.resolved.backup,
      target,
    },
  };
  const updatedConfig = configuredTarget !== target;
  if (updatedConfig) {
    await writeConfigFile(nextConfig, writeOptions);
  }

  const result: WorkspaceBackupInitResult = {
    target,
    detected: detected?.label,
    updatedConfig,
  };
  runtime.log(
    opts.json
      ? JSON.stringify(result, null, 2)
      : [
          updatedConfig
            ? `Configured workspace backup target: ${shortenHomePath(target)}`
            : `Workspace backup target: ${shortenHomePath(target)}`,
          ...(detected ? [`Detected cloud drive: ${detected.label}`] : []),
        ].join("\n"),
  );
  return result;
}

export async function workspaceBackupRunCommand(
  runtime: RuntimeEnv,
  opts: WorkspaceBackupRunOptions,
): Promise<WorkspaceBackupRunResult> {
  const { target, workspaceDirs, stateDir } = await resolveWorkspaceBackupState();
  const mirrorRoot = workspaceMirrorRoot(target);
  const stagingRoot = path.join(workspaceBackupRoot(target), ".staging");
  await fs.mkdir(mirrorRoot, { recursive: true });
  await fs.mkdir(stagingRoot, { recursive: true });
  await assertWorkspaceBackupSafety(target, stateDir, workspaceDirs);
  await assertPathContainedWithinRoot(mirrorRoot, workspaceBackupRoot(target), "write mirrors");
  await assertPathContainedWithinRoot(
    stagingRoot,
    workspaceBackupRoot(target),
    "write staging data",
  );

  const mirrored: WorkspaceBackupRunResult["workspaces"] = [];
  const activeSourcePaths = new Set<string>();
  const previousStatus = await readWorkspaceBackupStatus(target);

  for (const workspaceDir of workspaceDirs) {
    if (!(await pathExists(workspaceDir))) {
      continue;
    }
    const relativeDir = encodeAbsolutePathForBackupArchive(workspaceDir);
    const stagedDir = path.join(stagingRoot, `${relativeDir}-${randomUUID()}`);
    const targetDir = expectedMirrorPath(mirrorRoot, workspaceDir);
    await assertPathContainedWithinRoot(stagedDir, stagingRoot, "write staging data");
    await assertPathContainedWithinRoot(targetDir, mirrorRoot, "write workspace mirror");
    await fs.mkdir(path.dirname(stagedDir), { recursive: true });
    await fs.cp(workspaceDir, stagedDir, {
      recursive: true,
      force: true,
    });
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await replaceDirectoryAtomically(stagedDir, targetDir);
    activeSourcePaths.add(workspaceDir);
    mirrored.push({
      sourcePath: workspaceDir,
      backupPath: targetDir,
    });
  }

  for (const previous of previousStatus?.workspaces ?? []) {
    if (!activeSourcePaths.has(previous.sourcePath)) {
      const staleMirrorPath = expectedMirrorPath(mirrorRoot, previous.sourcePath);
      await assertPathContainedWithinRoot(staleMirrorPath, mirrorRoot, "remove stale mirror");
      await fs.rm(staleMirrorPath, { recursive: true, force: true });
    }
  }

  const updatedAt = new Date().toISOString();
  const statusFile: WorkspaceBackupStatusFile = {
    schemaVersion: WORKSPACE_BACKUP_SCHEMA_VERSION,
    updatedAt,
    workspaces: mirrored.map((workspace) => ({
      sourcePath: workspace.sourcePath,
    })),
  };
  await writeJsonAtomic(workspaceStatusPath(target), statusFile);

  const result: WorkspaceBackupRunResult = {
    target,
    updatedAt,
    workspaceCount: mirrored.length,
    workspaces: mirrored,
  };
  runtime.log(
    opts.json
      ? JSON.stringify(result, null, 2)
      : [
          `Workspace backup updated: ${shortenHomePath(target)}`,
          `Mirrored ${mirrored.length} workspace${mirrored.length === 1 ? "" : "s"}.`,
        ].join("\n"),
  );
  return result;
}

export async function getWorkspaceBackupStatus(): Promise<WorkspaceBackupStatusResult> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    throw new Error("Config is invalid. Workspace backup commands require a valid config file.");
  }
  const configuredTarget = resolveBackupConfigTarget(snapshot.config);
  const statusFile = configuredTarget
    ? await readWorkspaceBackupStatus(configuredTarget)
    : undefined;
  const detectedTarget = !configuredTarget ? await detectPreferredCloudDriveTarget() : undefined;
  return {
    configured: Boolean(configuredTarget),
    target: configuredTarget,
    detected: detectedTarget?.label,
    lastUpdatedAt: statusFile?.updatedAt,
    workspaceCount: statusFile?.workspaces.length ?? 0,
  };
}
