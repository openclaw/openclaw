import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { resolveDefaultAgentId, listAgentEntries } from "../agents/agent-scope.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import {
  createConfigIO,
  type OpenClawConfig,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/config.js";
import { writeTextFileAtomic } from "../secrets/shared.js";
import { pathExists, shortenHomePath } from "../utils.js";

type SyncLogger = {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

type MirrorGroupId = "repo" | "credentials" | "agent-state" | "workspace";

type MirrorGroup = {
  id: MirrorGroupId;
  label: string;
  sourcePath: string;
  targetPath: string;
  exclude: (relativePath: string, type: "file" | "dir" | "symlink") => boolean;
};

type WorkspaceMapping = {
  agentId: string;
  sourcePath: string;
  targetRelativePath: string;
};

type MirrorEntry = {
  groupId: MirrorGroupId;
  kind: "file" | "symlink";
  sourcePath: string;
  targetPath: string;
  relativePath: string;
  mode: number;
  linkTarget?: string;
};

export type MirrorAction = "add" | "update" | "unchanged";

export type MirrorOperation = {
  action: MirrorAction;
  groupId: MirrorGroupId;
  kind: "file" | "symlink";
  sourcePath: string;
  targetPath: string;
  relativePath: string;
  reason: "missing" | "content-mismatch" | "type-mismatch";
};

export type RemoteOnlyEntry = {
  groupId: MirrorGroupId;
  kind: "file" | "symlink";
  targetPath: string;
  relativePath: string;
};

export type ManagedSettingOperation = {
  action: "add" | "unchanged";
  targetPath: string;
  key: string;
  value: string;
};

export type LocalTruthSyncOptions = {
  targetHome: string;
  repoSource?: string;
  repoDest?: string;
  apply?: boolean;
  settingsOnly?: boolean;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type LocalTruthSyncResult = {
  schemaVersion: 1;
  createdAt: string;
  applied: boolean;
  settingsOnly: boolean;
  targetHome: string;
  targetStateDir: string;
  targetRepoDir: string | null;
  mirror: {
    operations: MirrorOperation[];
    remoteOnly: RemoteOnlyEntry[];
    counts: Record<MirrorAction, number>;
  };
  settings: {
    env: ManagedSettingOperation[];
    config: ManagedSettingOperation[];
  };
  warnings: string[];
};

const GENERIC_SKIP_SEGMENTS = new Set([".cache", "cache", "logs", "tmp"]);
const REPO_SKIP_SEGMENTS = new Set([".git", ".next", ".turbo", "coverage", "dist", "node_modules"]);
const MANAGED_ENV_KEYS = [
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_OPERATOR_DEB_URL",
  "OPENCLAW_OPERATOR_DEB_SHARED_SECRET",
  "OPENCLAW_OPERATOR_CONTROL_PLANE_URL",
  "OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET",
  "OPENCLAW_OPERATOR_INTERNAL_CONTROL_URL",
  "OPENCLAW_OPERATOR_INTERNAL_CONTROL_SHARED_SECRET",
  "OPENCLAW_OPERATOR_RECEIPT_BASE_URL",
] as const;
const TARGET_STATE_DIRNAME = "agents";
const TARGET_DEFAULT_WORKSPACE = "~/agents/workspace";
const TARGET_STATE_DIR_VALUE = "~/agents";

function createCounts(): Record<MirrorAction, number> {
  return {
    add: 0,
    update: 0,
    unchanged: 0,
  };
}

function createSilentLogger(): SyncLogger {
  return {
    warn: () => {},
    error: () => {},
  };
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function shouldSkipCommonRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => GENERIC_SKIP_SEGMENTS.has(segment))) {
    return true;
  }
  const base = segments.at(-1) ?? "";
  return (
    base === ".DS_Store" ||
    base === "Thumbs.db" ||
    base.endsWith(".log") ||
    base.endsWith(".tmp") ||
    base.endsWith(".swp")
  );
}

function shouldSkipRepoRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => REPO_SKIP_SEGMENTS.has(segment))) {
    return true;
  }
  return shouldSkipCommonRelativePath(normalized);
}

function shouldSkipStateRelativePath(relativePath: string): boolean {
  return shouldSkipCommonRelativePath(relativePath);
}

function isPathInsideOpenClawLegacyRoot(value: string): boolean {
  return /(^~\/\.openclaw(?:\/|$))|(\/\.openclaw(?:\/|$))/u.test(value.trim());
}

function trimString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function readSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function ensureParentDir(targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
}

async function removeExistingTargetIfNeeded(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
}

async function listSourceEntries(group: MirrorGroup): Promise<MirrorEntry[]> {
  if (!(await pathExists(group.sourcePath))) {
    return [];
  }

  const entries: MirrorEntry[] = [];
  const walk = async (sourcePath: string, relativePath: string): Promise<void> => {
    const stat = await fs.lstat(sourcePath);
    const type: "file" | "dir" | "symlink" = stat.isDirectory()
      ? "dir"
      : stat.isSymbolicLink()
        ? "symlink"
        : "file";
    if (relativePath && group.exclude(relativePath, type)) {
      return;
    }
    if (type === "dir") {
      const children = await fs.readdir(sourcePath);
      children.sort((left, right) => left.localeCompare(right));
      for (const child of children) {
        const nextRelativePath = relativePath ? path.join(relativePath, child) : child;
        await walk(path.join(sourcePath, child), nextRelativePath);
      }
      return;
    }
    entries.push({
      groupId: group.id,
      kind: type,
      sourcePath,
      targetPath: relativePath ? path.join(group.targetPath, relativePath) : group.targetPath,
      relativePath: normalizeRelativePath(relativePath),
      mode: stat.mode & 0o777,
      ...(type === "symlink" ? { linkTarget: await fs.readlink(sourcePath) } : {}),
    });
  };

  const rootStat = await fs.lstat(group.sourcePath);
  if (!rootStat.isDirectory()) {
    const type: "file" | "symlink" = rootStat.isSymbolicLink() ? "symlink" : "file";
    return [
      {
        groupId: group.id,
        kind: type,
        sourcePath: group.sourcePath,
        targetPath: group.targetPath,
        relativePath: "",
        mode: rootStat.mode & 0o777,
        ...(type === "symlink" ? { linkTarget: await fs.readlink(group.sourcePath) } : {}),
      },
    ];
  }

  await walk(group.sourcePath, "");
  entries.sort((left, right) => left.targetPath.localeCompare(right.targetPath));
  return entries;
}

async function listRemoteOnlyEntries(
  group: MirrorGroup,
  expectedRelativePaths: Set<string>,
): Promise<RemoteOnlyEntry[]> {
  if (!(await pathExists(group.targetPath))) {
    return [];
  }

  const stat = await fs.lstat(group.targetPath);
  if (!stat.isDirectory()) {
    return [];
  }

  const remoteOnly: RemoteOnlyEntry[] = [];
  const walk = async (targetPath: string, relativePath: string): Promise<void> => {
    const stat = await fs.lstat(targetPath);
    const type: "file" | "dir" | "symlink" = stat.isDirectory()
      ? "dir"
      : stat.isSymbolicLink()
        ? "symlink"
        : "file";
    if (relativePath && group.exclude(relativePath, type)) {
      return;
    }
    if (type === "dir") {
      const children = await fs.readdir(targetPath);
      children.sort((left, right) => left.localeCompare(right));
      for (const child of children) {
        const nextRelativePath = relativePath ? path.join(relativePath, child) : child;
        await walk(path.join(targetPath, child), nextRelativePath);
      }
      return;
    }
    const normalized = normalizeRelativePath(relativePath);
    if (!expectedRelativePaths.has(normalized)) {
      remoteOnly.push({
        groupId: group.id,
        kind: type,
        targetPath,
        relativePath: normalized,
      });
    }
  };

  await walk(group.targetPath, "");
  remoteOnly.sort((left, right) => left.targetPath.localeCompare(right.targetPath));
  return remoteOnly;
}

async function classifyMirrorOperation(entry: MirrorEntry): Promise<MirrorOperation> {
  let targetStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try {
    targetStat = await fs.lstat(entry.targetPath);
  } catch {
    return {
      action: "add",
      groupId: entry.groupId,
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      targetPath: entry.targetPath,
      relativePath: entry.relativePath,
      reason: "missing",
    };
  }

  const targetKind: MirrorEntry["kind"] = targetStat.isSymbolicLink() ? "symlink" : "file";
  if (targetKind !== entry.kind) {
    return {
      action: "update",
      groupId: entry.groupId,
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      targetPath: entry.targetPath,
      relativePath: entry.relativePath,
      reason: "type-mismatch",
    };
  }

  if (entry.kind === "symlink") {
    const currentTarget = await fs.readlink(entry.targetPath).catch(() => null);
    const action: MirrorAction = currentTarget === entry.linkTarget ? "unchanged" : "update";
    return {
      action,
      groupId: entry.groupId,
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      targetPath: entry.targetPath,
      relativePath: entry.relativePath,
      reason: action === "unchanged" ? "content-mismatch" : "content-mismatch",
    };
  }

  const [sourceHash, targetHash] = await Promise.all([
    readSha256(entry.sourcePath),
    readSha256(entry.targetPath),
  ]);
  const action: MirrorAction = sourceHash === targetHash ? "unchanged" : "update";
  return {
    action,
    groupId: entry.groupId,
    kind: entry.kind,
    sourcePath: entry.sourcePath,
    targetPath: entry.targetPath,
    relativePath: entry.relativePath,
    reason: action === "unchanged" ? "content-mismatch" : "content-mismatch",
  };
}

async function applyMirrorOperation(entry: MirrorOperation): Promise<void> {
  await ensureParentDir(entry.targetPath);
  if (entry.kind === "symlink") {
    const linkTarget = await fs.readlink(entry.sourcePath);
    await removeExistingTargetIfNeeded(entry.targetPath);
    await fs.symlink(linkTarget, entry.targetPath);
    return;
  }

  const sourceStat = await fs.lstat(entry.sourcePath);
  if (!sourceStat.isFile()) {
    throw new Error(`Expected file source for sync apply: ${entry.sourcePath}`);
  }
  await removeExistingTargetIfNeeded(entry.targetPath);
  await fs.copyFile(entry.sourcePath, entry.targetPath);
  await fs.chmod(entry.targetPath, sourceStat.mode & 0o777);
}

function buildWorkspaceMappings(
  config: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv,
): WorkspaceMapping[] {
  if (!config) {
    return [
      {
        agentId: "main",
        sourcePath: resolveDefaultAgentWorkspaceDir(env),
        targetRelativePath: "workspace",
      },
    ];
  }

  const defaultAgentId = resolveDefaultAgentId(config);
  const mappings = new Map<string, WorkspaceMapping>();
  const addMapping = (agentId: string, sourcePath: string) => {
    const targetRelativePath = agentId === defaultAgentId ? "workspace" : `workspace-${agentId}`;
    mappings.set(targetRelativePath, {
      agentId,
      sourcePath: path.resolve(sourcePath),
      targetRelativePath,
    });
  };

  addMapping(
    defaultAgentId,
    config.agents?.defaults?.workspace?.trim() || resolveDefaultAgentWorkspaceDir(env),
  );

  for (const entry of listAgentEntries(config)) {
    const workspace = trimString(entry.workspace);
    if (!workspace) {
      continue;
    }
    addMapping(entry.id, workspace);
  }

  return [...mappings.values()].toSorted((left, right) =>
    left.targetRelativePath.localeCompare(right.targetRelativePath),
  );
}

function buildManagedEnvValues(env: Record<string, string | undefined>): Record<string, string> {
  const values: Record<string, string> = {
    OPENCLAW_STATE_DIR: TARGET_STATE_DIR_VALUE,
  };

  for (const key of MANAGED_ENV_KEYS) {
    if (key === "OPENCLAW_STATE_DIR") {
      continue;
    }
    const value = env[key]?.trim();
    if (value) {
      values[key] = value;
    }
  }

  return values;
}

function formatEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@~-]+$/u.test(value) ? value : JSON.stringify(value);
}

function appendEnvAssignments(raw: string, additions: ManagedSettingOperation[]): string {
  const prefix = raw.length === 0 || raw.endsWith("\n") ? raw : `${raw}\n`;
  const lines = additions.map((entry) => `${entry.key}=${formatEnvValue(entry.value)}`);
  return lines.length === 0 ? prefix : `${prefix}${lines.join("\n")}\n`;
}

function collectLegacyWorkspaceWarnings(
  config: OpenClawConfig | undefined,
  warnings: string[],
): void {
  if (!config) {
    return;
  }

  const defaultWorkspace = trimString(config.agents?.defaults?.workspace);
  if (defaultWorkspace && isPathInsideOpenClawLegacyRoot(defaultWorkspace)) {
    warnings.push(
      `Target config keeps agents.defaults.workspace=${defaultWorkspace}; sync does not rewrite existing workspace paths automatically.`,
    );
  }

  for (const entry of listAgentEntries(config)) {
    const workspace = trimString(entry.workspace);
    if (!workspace || !isPathInsideOpenClawLegacyRoot(workspace)) {
      continue;
    }
    warnings.push(
      `Target config keeps agents.list[id=${entry.id}].workspace=${workspace}; update it manually when that pod should move under ~/agents.`,
    );
  }
}

async function planManagedEnvSettings(params: {
  targetEnvPath: string;
  sourceEnv: Record<string, string | undefined>;
  apply: boolean;
  warnings: string[];
}): Promise<ManagedSettingOperation[]> {
  const raw = (await fs.readFile(params.targetEnvPath, "utf8").catch(() => "")) ?? "";
  const existing = dotenv.parse(raw);
  const desired = buildManagedEnvValues(params.sourceEnv);
  const operations: ManagedSettingOperation[] = [];

  const existingStateDir = existing.OPENCLAW_STATE_DIR?.trim();
  if (existingStateDir && existingStateDir !== TARGET_STATE_DIR_VALUE) {
    params.warnings.push(
      `Target env already sets OPENCLAW_STATE_DIR=${existingStateDir}; sync leaves existing values unchanged.`,
    );
  }

  for (const key of Object.keys(desired).toSorted((left, right) => left.localeCompare(right))) {
    const value = desired[key] ?? "";
    const current = existing[key]?.trim();
    operations.push({
      action: current ? "unchanged" : "add",
      targetPath: params.targetEnvPath,
      key,
      value,
    });
  }

  if (params.apply) {
    const additions = operations.filter((entry) => entry.action === "add");
    if (additions.length > 0) {
      await ensureParentDir(params.targetEnvPath);
      writeTextFileAtomic(params.targetEnvPath, appendEnvAssignments(raw, additions));
    }
  }

  return operations;
}

async function planManagedConfigSettings(params: {
  targetHome: string;
  targetConfigPath: string;
  apply: boolean;
  warnings: string[];
}): Promise<ManagedSettingOperation[]> {
  const targetEnv = {
    HOME: params.targetHome,
    OPENCLAW_HOME: params.targetHome,
    OPENCLAW_STATE_DIR: path.join(params.targetHome, TARGET_STATE_DIRNAME),
    OPENCLAW_CONFIG_PATH: params.targetConfigPath,
  } as NodeJS.ProcessEnv;
  const io = createConfigIO({
    env: targetEnv,
    homedir: () => params.targetHome,
    logger: createSilentLogger(),
  });
  const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();

  if (snapshot.exists && !snapshot.valid) {
    params.warnings.push(
      `Target config is invalid at ${params.targetConfigPath}; sync skipped managed config updates.`,
    );
    return [];
  }

  collectLegacyWorkspaceWarnings(snapshot.valid ? snapshot.config : undefined, params.warnings);
  const currentWorkspace = trimString(snapshot.config.agents?.defaults?.workspace);
  const operation: ManagedSettingOperation = {
    action: currentWorkspace ? "unchanged" : "add",
    targetPath: params.targetConfigPath,
    key: "agents.defaults.workspace",
    value: TARGET_DEFAULT_WORKSPACE,
  };

  if (params.apply && operation.action === "add") {
    const nextConfig = structuredClone(snapshot.config);
    nextConfig.agents ??= {};
    nextConfig.agents.defaults ??= {};
    nextConfig.agents.defaults.workspace = TARGET_DEFAULT_WORKSPACE;
    await io.writeConfigFile(nextConfig, writeOptions);
  }

  return [operation];
}

async function resolveSourceConfig(env: NodeJS.ProcessEnv): Promise<{
  config: OpenClawConfig | undefined;
  warnings: string[];
}> {
  const io = createConfigIO({
    env,
    logger: createSilentLogger(),
  });
  const snapshot = await io.readConfigFileSnapshot();
  if (snapshot.valid) {
    return { config: snapshot.config, warnings: [] };
  }
  return {
    config: undefined,
    warnings: [
      `Local config is invalid at ${snapshot.path}; sync fell back to the default workspace mapping only.`,
    ],
  };
}

function buildMirrorGroups(params: {
  options: LocalTruthSyncOptions;
  env: NodeJS.ProcessEnv;
  targetHome: string;
  targetStateDir: string;
  targetRepoDir: string | null;
  config: OpenClawConfig | undefined;
}): MirrorGroup[] {
  const groups: MirrorGroup[] = [];
  if (!params.options.settingsOnly && params.targetRepoDir) {
    groups.push({
      id: "repo",
      label: "repo",
      sourcePath: path.resolve(params.options.repoSource ?? process.cwd()),
      targetPath: params.targetRepoDir,
      exclude: (relativePath) => shouldSkipRepoRelativePath(relativePath),
    });
  }

  groups.push({
    id: "credentials",
    label: "credentials",
    sourcePath: path.resolve(resolveOAuthDir(params.env)),
    targetPath: path.join(params.targetStateDir, "credentials"),
    exclude: (relativePath) => shouldSkipStateRelativePath(relativePath),
  });
  groups.push({
    id: "agent-state",
    label: "agent-state",
    sourcePath: path.join(resolveStateDir(params.env), "agents"),
    targetPath: path.join(params.targetStateDir, "agents"),
    exclude: (relativePath) => shouldSkipStateRelativePath(relativePath),
  });

  for (const workspace of buildWorkspaceMappings(params.config, params.env)) {
    groups.push({
      id: "workspace",
      label: `workspace:${workspace.agentId}`,
      sourcePath: workspace.sourcePath,
      targetPath: path.join(params.targetStateDir, workspace.targetRelativePath),
      exclude: (relativePath) => shouldSkipStateRelativePath(relativePath),
    });
  }

  return groups;
}

function resolveTargetRepoDir(options: LocalTruthSyncOptions, targetHome: string): string | null {
  if (options.settingsOnly) {
    return null;
  }
  const repoSource = path.resolve(options.repoSource ?? process.cwd());
  const repoDest = trimString(options.repoDest) ?? path.basename(repoSource) ?? "repo";
  if (path.isAbsolute(repoDest)) {
    throw new Error("--repo-dest must be relative to the target home");
  }
  const targetRepoDir = path.join(targetHome, repoDest);
  const relative = path.relative(targetHome, targetRepoDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("--repo-dest must stay within the target home");
  }
  return targetRepoDir;
}

export async function runLocalTruthSync(
  options: LocalTruthSyncOptions,
): Promise<LocalTruthSyncResult> {
  const env = options.env ?? process.env;
  const apply = Boolean(options.apply);
  const targetHome = path.resolve(options.targetHome);
  const targetStateDir = path.join(targetHome, TARGET_STATE_DIRNAME);
  const targetRepoDir = resolveTargetRepoDir(options, targetHome);
  const createdAt = new Date(options.nowMs ?? Date.now()).toISOString();
  const { config: sourceConfig, warnings } = await resolveSourceConfig(env);
  const mirrorCounts = createCounts();
  const mirrorOperations: MirrorOperation[] = [];
  const remoteOnly: RemoteOnlyEntry[] = [];

  const mirrorGroups = buildMirrorGroups({
    options,
    env,
    targetHome,
    targetStateDir,
    targetRepoDir,
    config: sourceConfig,
  });

  if (!options.settingsOnly) {
    for (const group of mirrorGroups) {
      if (!(await pathExists(group.sourcePath))) {
        warnings.push(`Skipped ${group.label}: source path is missing (${group.sourcePath}).`);
        continue;
      }
      const entries = await listSourceEntries(group);
      const expectedRelativePaths = new Set(entries.map((entry) => entry.relativePath));
      const groupOperations = await Promise.all(
        entries.map(async (entry) => await classifyMirrorOperation(entry)),
      );
      groupOperations.sort((left, right) => left.targetPath.localeCompare(right.targetPath));
      for (const operation of groupOperations) {
        mirrorCounts[operation.action] += 1;
        mirrorOperations.push(operation);
        if (apply && operation.action !== "unchanged") {
          await applyMirrorOperation(operation);
        }
      }
      if (apply) {
        await fs.mkdir(group.targetPath, { recursive: true });
      }
      remoteOnly.push(...(await listRemoteOnlyEntries(group, expectedRelativePaths)));
    }
  }

  const stateEnvPath = path.join(resolveStateDir(env), ".env");
  const localEnvRaw = await fs.readFile(stateEnvPath, "utf8").catch(() => "");
  const sourceEnv = {
    ...dotenv.parse(localEnvRaw),
    ...Object.fromEntries(
      Object.entries(env).map(([key, value]) => [
        key,
        typeof value === "string" ? value : undefined,
      ]),
    ),
  } as Record<string, string | undefined>;

  const settingsEnv = await planManagedEnvSettings({
    targetEnvPath: path.join(targetStateDir, ".env"),
    sourceEnv,
    apply,
    warnings,
  });
  const settingsConfig = await planManagedConfigSettings({
    targetHome,
    targetConfigPath: path.join(targetStateDir, "openclaw.json"),
    apply,
    warnings,
  });

  remoteOnly.sort((left, right) => left.targetPath.localeCompare(right.targetPath));

  return {
    schemaVersion: 1,
    createdAt,
    applied: apply,
    settingsOnly: Boolean(options.settingsOnly),
    targetHome,
    targetStateDir,
    targetRepoDir,
    mirror: {
      operations: mirrorOperations,
      remoteOnly,
      counts: mirrorCounts,
    },
    settings: {
      env: settingsEnv,
      config: settingsConfig,
    },
    warnings,
  };
}

export function formatLocalTruthSyncSummary(result: LocalTruthSyncResult): string[] {
  const lines = [
    `Target home: ${shortenHomePath(result.targetHome)}`,
    `Target state root: ${shortenHomePath(result.targetStateDir)}`,
  ];
  if (result.targetRepoDir) {
    lines.push(`Target repo root: ${shortenHomePath(result.targetRepoDir)}`);
  }
  lines.push(
    `Mirror changes: add=${result.mirror.counts.add}, update=${result.mirror.counts.update}, unchanged=${result.mirror.counts.unchanged}`,
  );
  lines.push(`Remote-only entries kept: ${result.mirror.remoteOnly.length}`);
  const envAdds = result.settings.env.filter((entry) => entry.action === "add").length;
  const configAdds = result.settings.config.filter((entry) => entry.action === "add").length;
  lines.push(`Managed env additions: ${envAdds}`);
  lines.push(`Managed config additions: ${configAdds}`);
  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push(
    result.applied
      ? "Applied add/update operations and managed setting additions."
      : "Dry run only; no files or settings were changed.",
  );
  return lines;
}
