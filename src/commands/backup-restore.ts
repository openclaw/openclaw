import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import {
  clearConfigCache,
  parseConfigJson5,
  readConfigFileSnapshot,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
  type OpenClawConfig,
  validateConfigObjectRawWithPlugins,
} from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { pathExists, resolveUserPath, shortenHomePath } from "../utils.js";
import { readVerifiedBackupArchive, type BackupManifestAsset } from "./backup-archive.js";
import type { BackupAssetKind } from "./backup-shared.js";
import { collectWorkspaceDirs, isPathWithin } from "./cleanup-utils.js";

export type BackupRestoreOptions = {
  archive: string;
  dryRun?: boolean;
  force?: boolean;
  includeWorkspace?: boolean;
  json?: boolean;
};

type RestoreTargetType = "file" | "directory";

type BackupRestoreItem = {
  kind: BackupAssetKind;
  sourcePath: string;
  archivePath: string;
  targetPath: string;
  displayTargetPath: string;
  targetType: RestoreTargetType;
};

type StagedBackupRestoreItem = BackupRestoreItem & {
  stagedPath: string;
};

type RestoreTransactionItem = StagedBackupRestoreItem & {
  publishPath: string;
  rollbackPath: string | null;
  published: boolean;
};

type BackupRestoreSkipped = {
  kind: string;
  sourcePath: string;
  displayPath: string;
  reason: string;
};

export type BackupRestoreResult = {
  archivePath: string;
  createdAt: string;
  runtimeVersion: string;
  dryRun: boolean;
  force: boolean;
  includeWorkspace: boolean;
  restored: Array<{
    kind: BackupAssetKind;
    sourcePath: string;
    targetPath: string;
  }>;
  skipped: BackupRestoreSkipped[];
  updatedConfigWorkspacePaths: number;
};

function isKnownBackupKind(value: string): value is BackupAssetKind {
  return (
    value === "state" || value === "config" || value === "credentials" || value === "workspace"
  );
}

function restoreTargetType(kind: BackupAssetKind): RestoreTargetType {
  return kind === "config" ? "file" : "directory";
}

function restorePriority(kind: BackupAssetKind): number {
  switch (kind) {
    case "state":
      return 0;
    case "config":
      return 1;
    case "credentials":
      return 2;
    case "workspace":
      return 3;
  }
}

function normalizeWorkspaceAssetOrder(
  manifestWorkspaceDirs: string[] | undefined,
  assets: BackupManifestAsset[],
): BackupManifestAsset[] {
  if (!manifestWorkspaceDirs || manifestWorkspaceDirs.length === 0) {
    return [...assets].toSorted((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  }

  const indexBySource = new Map(
    manifestWorkspaceDirs.map((workspaceDir, index) => [path.resolve(workspaceDir), index]),
  );
  return [...assets].toSorted((left, right) => {
    const leftIndex = indexBySource.get(path.resolve(left.sourcePath)) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = indexBySource.get(path.resolve(right.sourcePath)) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    return left.sourcePath.localeCompare(right.sourcePath);
  });
}

async function canonicalizePath(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const suffix: string[] = [];
  let probe = resolved;

  while (true) {
    try {
      const realProbe = await fs.realpath(probe);
      return suffix.length === 0 ? realProbe : path.join(realProbe, ...suffix.toReversed());
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

function normalizeConfigWorkspacePath(value: string): string {
  return path.resolve(resolveUserPath(value));
}

function toArchiveSubpath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}

function isArchivePathWithin(child: string, parent: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === "" || (!relative.startsWith("../") && relative !== "..");
}

function buildCoveredAssetArchivePath(params: {
  kind: BackupAssetKind;
  coveredSourcePath: string;
  backupStateDir: string | undefined;
  stateArchivePath: string | undefined;
  entryPaths: Set<string>;
}): string | undefined {
  if (!params.backupStateDir || !params.stateArchivePath) {
    return undefined;
  }

  const backupStateAliases = buildPathAliases(path.resolve(params.backupStateDir));
  const coveredSourceAliases = buildPathAliases(path.resolve(params.coveredSourcePath));
  let fallbackCandidate: string | undefined;

  for (const backupStateAlias of backupStateAliases) {
    for (const coveredSourceAlias of coveredSourceAliases) {
      if (!isPathWithin(coveredSourceAlias, backupStateAlias)) {
        continue;
      }

      const relative = path.relative(backupStateAlias, coveredSourceAlias);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }

      const candidate = path.posix.join(params.stateArchivePath, toArchiveSubpath(relative));
      fallbackCandidate ??= candidate;
      const hasExactEntry = params.entryPaths.has(candidate);
      const hasNestedEntry = [...params.entryPaths].some(
        (entryPath) => entryPath !== candidate && isArchivePathWithin(entryPath, candidate),
      );
      if (params.kind === "config" ? hasExactEntry : hasExactEntry || hasNestedEntry) {
        return candidate;
      }
    }
  }
  return fallbackCandidate;
}

function buildCoveredAssetManifestEntries(params: {
  verifiedArchive: Awaited<ReturnType<typeof readVerifiedBackupArchive>>;
  currentStateDir: string;
  currentConfigPath: string;
  currentOauthDir: string;
}): BackupManifestAsset[] {
  const verifiedArchive = params.verifiedArchive;
  const manifest = verifiedArchive.manifest;
  const supportedCoveredKinds: BackupAssetKind[] = ["config", "credentials"];
  const explicitKinds = new Set(manifest.assets.map((asset) => asset.kind));
  const stateAssetArchivePath = manifest.assets.find(
    (asset) => asset.kind === "state",
  )?.archivePath;
  const coveredEntries = Array.isArray(manifest.skipped) ? manifest.skipped : [];
  const synthesized: BackupManifestAsset[] = [];

  for (const kind of supportedCoveredKinds) {
    if (explicitKinds.has(kind)) {
      continue;
    }

    const activeTargetPath = kind === "config" ? params.currentConfigPath : params.currentOauthDir;
    if (isPathWithin(activeTargetPath, params.currentStateDir)) {
      continue;
    }

    const skippedCoveredEntry = coveredEntries.find(
      (entry) =>
        entry?.kind === kind &&
        entry?.reason === "covered" &&
        typeof entry?.sourcePath === "string" &&
        entry.sourcePath.trim().length > 0,
    );
    const legacyCoveredSourcePath =
      kind === "config" ? manifest.paths?.configPath : manifest.paths?.oauthDir;
    const coveredSourcePath = skippedCoveredEntry?.sourcePath ?? legacyCoveredSourcePath;
    if (!coveredSourcePath?.trim()) {
      continue;
    }

    const archivePath = buildCoveredAssetArchivePath({
      kind,
      coveredSourcePath,
      backupStateDir: manifest.paths?.stateDir,
      stateArchivePath: stateAssetArchivePath,
      entryPaths: verifiedArchive.entryPaths,
    });
    if (!archivePath) {
      continue;
    }

    synthesized.push({
      kind,
      sourcePath: coveredSourcePath,
      archivePath,
    });
  }

  return synthesized;
}

function buildPathAliases(inputPath: string): string[] {
  const resolved = path.resolve(inputPath);
  const aliases = new Set([resolved]);
  if (resolved.startsWith("/private/var/")) {
    aliases.add(resolved.slice("/private".length));
  } else if (resolved.startsWith("/var/")) {
    aliases.add(path.join("/private", resolved));
  }
  return [...aliases];
}

function rewriteWorkspacePathsInConfig(
  cfg: OpenClawConfig,
  rewrites: Map<string, string>,
): { nextConfig: OpenClawConfig; updatedCount: number } {
  const nextConfig = structuredClone(cfg);
  let updatedCount = 0;

  const rewrite = (workspace: string | undefined): string | undefined => {
    if (!workspace?.trim()) {
      return workspace;
    }
    const mapped = buildPathAliases(normalizeConfigWorkspacePath(workspace))
      .map((candidate) => rewrites.get(candidate))
      .find((candidate): candidate is string => typeof candidate === "string");
    if (!mapped || mapped === workspace) {
      return workspace;
    }
    updatedCount += 1;
    return mapped;
  };

  if (typeof nextConfig.agents?.defaults?.workspace === "string") {
    nextConfig.agents.defaults.workspace = rewrite(nextConfig.agents.defaults.workspace) ?? "";
  }

  if (Array.isArray(nextConfig.agents?.list)) {
    for (const agent of nextConfig.agents.list) {
      if (typeof agent.workspace === "string") {
        agent.workspace = rewrite(agent.workspace) ?? "";
      }
    }
  }

  return { nextConfig, updatedCount };
}

async function buildWorkspaceBaseMapping(
  workspaceAssets: BackupManifestAsset[],
  backupStateDir: string | undefined,
  currentStateDir: string,
): Promise<Map<string, string> | null> {
  if (!backupStateDir) {
    return null;
  }

  const oldBaseDir = path.dirname(await canonicalizePath(backupStateDir));
  const currentBaseDir = path.dirname(path.resolve(currentStateDir));
  const mapping = new Map<string, string>();

  for (const asset of workspaceAssets) {
    const normalizedSourcePath = path.resolve(asset.sourcePath);
    if (!isPathWithin(normalizedSourcePath, oldBaseDir)) {
      return null;
    }
    mapping.set(
      normalizedSourcePath,
      path.resolve(currentBaseDir, path.relative(oldBaseDir, normalizedSourcePath)),
    );
  }

  return mapping;
}

async function resolveWorkspaceRestoreTargets(params: {
  workspaceAssets: BackupManifestAsset[];
  manifestWorkspaceDirs: string[] | undefined;
  backupStateDir: string | undefined;
  currentStateDir: string;
}): Promise<Map<string, string>> {
  if (params.workspaceAssets.length === 0) {
    return new Map();
  }

  const orderedAssets = normalizeWorkspaceAssetOrder(
    params.manifestWorkspaceDirs,
    params.workspaceAssets,
  );
  const currentSnapshot = await readConfigFileSnapshot().catch(() => null);
  const currentConfigExists = await pathExists(path.resolve(resolveConfigPath()));
  const currentWorkspaceDirs =
    currentConfigExists && currentSnapshot?.valid && currentSnapshot.config
      ? collectWorkspaceDirs(currentSnapshot.config)
      : [];

  const currentWorkspaceByPath = new Map(
    currentWorkspaceDirs.map((workspaceDir) => [
      path.resolve(workspaceDir),
      path.resolve(workspaceDir),
    ]),
  );
  const exactCurrentWorkspaceTargets = orderedAssets.map((asset) =>
    currentWorkspaceByPath.get(path.resolve(asset.sourcePath)),
  );
  if (
    exactCurrentWorkspaceTargets.every((targetPath): targetPath is string => Boolean(targetPath))
  ) {
    return new Map(
      orderedAssets.map((asset, index) => [
        path.resolve(asset.sourcePath),
        path.resolve(exactCurrentWorkspaceTargets[index] ?? resolveDefaultAgentWorkspaceDir()),
      ]),
    );
  }

  const remappedFromBackupBase = await buildWorkspaceBaseMapping(
    orderedAssets,
    params.backupStateDir,
    params.currentStateDir,
  );
  if (remappedFromBackupBase) {
    return remappedFromBackupBase;
  }

  if (orderedAssets.length === 1) {
    return new Map([
      [
        path.resolve(orderedAssets[0]?.sourcePath ?? ""),
        path.resolve(resolveDefaultAgentWorkspaceDir()),
      ],
    ]);
  }

  throw new Error(
    `Cannot determine restore targets for ${orderedAssets.length} backed-up workspaces. Configure matching workspaces first or rerun with --no-include-workspace.`,
  );
}

async function buildRestoreItems(params: {
  archivePath: string;
  includeWorkspace: boolean;
}): Promise<{
  items: BackupRestoreItem[];
  skipped: BackupRestoreSkipped[];
  workspaceRewrites: Map<string, string>;
  createdAt: string;
  runtimeVersion: string;
}> {
  const verifiedArchive = await readVerifiedBackupArchive(params.archivePath);
  const manifest = verifiedArchive.manifest;
  const currentStateDir = path.resolve(resolveStateDir());
  const currentConfigPath = path.resolve(resolveConfigPath());
  const currentOauthDir = path.resolve(resolveOAuthDir());

  const workspaceAssets = manifest.assets.filter((asset) => asset.kind === "workspace");
  const workspaceTargets = params.includeWorkspace
    ? await resolveWorkspaceRestoreTargets({
        workspaceAssets,
        manifestWorkspaceDirs: manifest.paths?.workspaceDirs,
        backupStateDir: manifest.paths?.stateDir,
        currentStateDir,
      })
    : new Map<string, string>();
  const restorableAssets = [
    ...manifest.assets,
    ...buildCoveredAssetManifestEntries({
      verifiedArchive,
      currentStateDir,
      currentConfigPath,
      currentOauthDir,
    }),
  ];

  const items: BackupRestoreItem[] = [];
  const skipped: BackupRestoreSkipped[] = [];
  const workspaceRewrites = new Map<string, string>();

  for (const asset of restorableAssets) {
    if (!isKnownBackupKind(asset.kind)) {
      throw new Error(`Unsupported backup asset kind: ${asset.kind}`);
    }

    if (asset.kind === "workspace" && !params.includeWorkspace) {
      skipped.push({
        kind: asset.kind,
        sourcePath: asset.sourcePath,
        displayPath: shortenHomePath(asset.sourcePath),
        reason: "excluded by --no-include-workspace",
      });
      continue;
    }

    const targetPath =
      asset.kind === "state"
        ? currentStateDir
        : asset.kind === "config"
          ? currentConfigPath
          : asset.kind === "credentials"
            ? currentOauthDir
            : workspaceTargets.get(path.resolve(asset.sourcePath));

    if (!targetPath) {
      throw new Error(`Missing restore target for workspace asset: ${asset.sourcePath}`);
    }

    if (asset.kind === "workspace") {
      for (const alias of buildPathAliases(asset.sourcePath)) {
        workspaceRewrites.set(alias, path.resolve(targetPath));
      }
    }

    items.push({
      kind: asset.kind,
      sourcePath: path.resolve(asset.sourcePath),
      archivePath: asset.archivePath,
      targetPath: path.resolve(targetPath),
      displayTargetPath: shortenHomePath(path.resolve(targetPath)),
      targetType: restoreTargetType(asset.kind),
    });
  }

  items.sort((left, right) => restorePriority(left.kind) - restorePriority(right.kind));
  return {
    items,
    skipped,
    workspaceRewrites,
    createdAt: manifest.createdAt,
    runtimeVersion: manifest.runtimeVersion,
  };
}

async function assertRestoreTargetsReady(params: {
  archivePath: string;
  items: BackupRestoreItem[];
  force: boolean;
}): Promise<void> {
  const archiveRealPath = await canonicalizePath(params.archivePath);
  const conflicts: string[] = [];

  for (const item of params.items) {
    const targetRealPath = await canonicalizePath(item.targetPath);
    const targetExists = await pathExists(item.targetPath);
    if (targetExists && !params.force) {
      const isEmptyDirectory =
        item.targetType === "directory" &&
        (await fs
          .readdir(item.targetPath)
          .then((entries) => entries.length === 0)
          .catch(() => false));
      if (!isEmptyDirectory) {
        conflicts.push(item.displayTargetPath);
      }
    }
    if (isPathWithin(archiveRealPath, targetRealPath)) {
      throw new Error(
        `Restore archive must not live inside a restore target: ${archiveRealPath} is inside ${targetRealPath}`,
      );
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Restore target already exists. Rerun with --force to replace it: ${conflicts.join(", ")}`,
    );
  }
}

function matchesArchivePath(entryPath: string, assetArchivePath: string): boolean {
  const normalizedEntryPath = entryPath.replace(/\/+$/u, "");
  return (
    normalizedEntryPath === assetArchivePath ||
    normalizedEntryPath.startsWith(`${assetArchivePath}/`)
  );
}

async function extractAssetToStage(params: {
  archivePath: string;
  assetArchivePath: string;
  stageRoot: string;
  targetType: RestoreTargetType;
}): Promise<string> {
  const archivePathParts = params.assetArchivePath.split("/");
  const strip = Math.max(archivePathParts.length - 1, 0);
  await tar.x({
    file: params.archivePath,
    gzip: true,
    cwd: params.stageRoot,
    strip,
    onentry: (entry) => {
      if (entry.type === "Link" || entry.type === "SymbolicLink") {
        throw new Error(`Restore archive contains unsupported link entry: ${entry.path}`);
      }
    },
    filter: (entryPath) => matchesArchivePath(entryPath, params.assetArchivePath),
  });
  const stagedAssetPath = path.join(params.stageRoot, path.posix.basename(params.assetArchivePath));
  if (
    params.targetType === "directory" &&
    !(await pathExists(stagedAssetPath)) &&
    (await fs.readdir(params.stageRoot).catch(() => [])).length > 0
  ) {
    return params.stageRoot;
  }
  return stagedAssetPath;
}

async function copyStagedAsset(params: {
  stagedPath: string;
  targetPath: string;
  targetType: RestoreTargetType;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.targetPath), { recursive: true });
  if (params.targetType === "directory") {
    await fs.cp(params.stagedPath, params.targetPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    return;
  }

  await fs.cp(params.stagedPath, params.targetPath, {
    force: false,
    errorOnExist: true,
  });
}

async function applyWorkspaceConfigRewritesToStagedConfig(
  stagedConfigPath: string,
  workspaceRewrites: Map<string, string>,
): Promise<number> {
  if (workspaceRewrites.size === 0) {
    return 0;
  }

  const raw = await fs.readFile(stagedConfigPath, "utf8");
  const parsed = parseConfigJson5(raw);
  if (!parsed.ok) {
    throw new Error(
      `Restored config is invalid JSON5; workspace path rewrites could not be applied: ${parsed.error}`,
    );
  }

  const validated = validateConfigObjectRawWithPlugins(parsed.parsed);
  if (!validated.ok) {
    throw new Error("Restored config is invalid; workspace path rewrites could not be applied.");
  }

  const { nextConfig, updatedCount } = rewriteWorkspacePathsInConfig(
    validated.config,
    workspaceRewrites,
  );
  if (updatedCount === 0) {
    return 0;
  }

  const rewritten = validateConfigObjectRawWithPlugins(nextConfig);
  if (!rewritten.ok) {
    throw new Error("Workspace path rewrites produced an invalid restored config.");
  }

  await fs.writeFile(stagedConfigPath, `${JSON.stringify(rewritten.config, null, 2)}\n`, "utf8");
  return updatedCount;
}

async function stageRestoreItems(params: {
  archivePath: string;
  items: BackupRestoreItem[];
  workspaceRewrites: Map<string, string>;
  stageRoot: string;
}): Promise<{
  stagedItems: StagedBackupRestoreItem[];
  updatedConfigWorkspacePaths: number;
}> {
  const stagedItems: StagedBackupRestoreItem[] = [];

  for (const [index, item] of params.items.entries()) {
    const assetStageRoot = path.join(params.stageRoot, String(index));
    await fs.mkdir(assetStageRoot, { recursive: true });
    const stagedAssetPath = await extractAssetToStage({
      archivePath: params.archivePath,
      assetArchivePath: item.archivePath,
      stageRoot: assetStageRoot,
      targetType: item.targetType,
    });
    if (!(await pathExists(stagedAssetPath))) {
      throw new Error(`Restore staging failed for asset: ${item.archivePath}`);
    }

    stagedItems.push({
      ...item,
      stagedPath: stagedAssetPath,
    });
  }

  const configItem = stagedItems.find((item) => item.kind === "config");
  const updatedConfigWorkspacePaths = configItem
    ? await applyWorkspaceConfigRewritesToStagedConfig(
        configItem.stagedPath,
        params.workspaceRewrites,
      )
    : 0;

  return {
    stagedItems,
    updatedConfigWorkspacePaths,
  };
}

function buildRestoreTempSiblingPath(targetPath: string, prefix: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${prefix}-${path.basename(targetPath)}-${randomUUID()}`,
  );
}

async function publishRestoreItem(params: {
  item: StagedBackupRestoreItem;
  publishPath: string;
}): Promise<void> {
  await copyStagedAsset({
    stagedPath: params.item.stagedPath,
    targetPath: params.publishPath,
    targetType: params.item.targetType,
  });

  if (await pathExists(params.item.targetPath)) {
    throw new Error(
      `Restore target changed during publication and would be overwritten: ${params.item.targetPath}`,
    );
  }

  await fs.rename(params.publishPath, params.item.targetPath);
}

async function rollbackRestorePublication(items: RestoreTransactionItem[]): Promise<void> {
  for (const item of items.toReversed()) {
    await fs.rm(item.publishPath, { recursive: true, force: true }).catch(() => undefined);

    if (item.published) {
      await fs.rm(item.targetPath, { recursive: true, force: true }).catch(() => undefined);
    }

    if (item.rollbackPath) {
      const rollbackPath = item.rollbackPath;
      if (await pathExists(item.targetPath)) {
        await fs.rm(item.targetPath, { recursive: true, force: true }).catch(() => undefined);
      }
      await fs.mkdir(path.dirname(item.targetPath), { recursive: true }).catch(() => undefined);
      await fs.rename(rollbackPath, item.targetPath).catch(async () => {
        if (!(await pathExists(rollbackPath))) {
          return;
        }
        throw new Error(`Failed to roll back restore target: ${item.targetPath}`);
      });
    }
  }
}

async function publishRestorePlan(stagedItems: StagedBackupRestoreItem[]): Promise<void> {
  const transactionItems: RestoreTransactionItem[] = stagedItems.map((item) => ({
    ...item,
    publishPath: buildRestoreTempSiblingPath(item.targetPath, "openclaw-restore"),
    rollbackPath: null,
    published: false,
  }));

  try {
    for (const item of transactionItems) {
      await fs.mkdir(path.dirname(item.targetPath), { recursive: true });

      if (await pathExists(item.targetPath)) {
        item.rollbackPath = buildRestoreTempSiblingPath(
          item.targetPath,
          "openclaw-restore-rollback",
        );
        await fs.rename(item.targetPath, item.rollbackPath);
      }

      await publishRestoreItem({
        item,
        publishPath: item.publishPath,
      });
      item.published = true;
    }
  } catch (err) {
    await rollbackRestorePublication(transactionItems);
    throw err;
  }

  for (const item of transactionItems) {
    if (item.rollbackPath) {
      await fs.rm(item.rollbackPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function chmodIfPresent(
  targetPath: string,
  mode: number,
  require: "file" | "dir",
): Promise<void> {
  try {
    const st = await fs.lstat(targetPath);
    if (st.isSymbolicLink()) {
      return;
    }
    if (require === "file" && !st.isFile()) {
      return;
    }
    if (require === "dir" && !st.isDirectory()) {
      return;
    }
    await fs.chmod(targetPath, mode);
  } catch {
    // Best-effort hardening only.
  }
}

async function chmodTreeFiles(
  targetPath: string,
  dirMode: number,
  fileMode: number,
): Promise<void> {
  await chmodIfPresent(targetPath, dirMode, "dir");
  const entries = await fs.readdir(targetPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      await chmodTreeFiles(entryPath, dirMode, fileMode);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await chmodIfPresent(entryPath, fileMode, "file");
  }
}

async function applyRestorePermissionBaseline(): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  await chmodIfPresent(resolveStateDir(), 0o700, "dir");
  await chmodIfPresent(resolveConfigPath(), 0o600, "file");
  await chmodTreeFiles(resolveOAuthDir(), 0o700, 0o600);
}

function formatRestoreSummary(result: BackupRestoreResult): string {
  const lines = [
    result.dryRun
      ? `Planned restore from backup archive: ${sanitizeTerminalText(shortenHomePath(result.archivePath))}`
      : `Restored backup archive: ${sanitizeTerminalText(shortenHomePath(result.archivePath))}`,
    `Backup created at: ${sanitizeTerminalText(result.createdAt)}`,
    `Backup runtime version: ${sanitizeTerminalText(result.runtimeVersion)}`,
  ];

  lines.push(
    `${result.dryRun ? "Planned" : "Restored"} ${result.restored.length} path${
      result.restored.length === 1 ? "" : "s"
    }:`,
  );
  for (const entry of result.restored) {
    lines.push(`- ${entry.kind}: ${sanitizeTerminalText(shortenHomePath(entry.targetPath))}`);
  }

  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length} path${result.skipped.length === 1 ? "" : "s"}:`);
    for (const entry of result.skipped) {
      lines.push(
        `- ${entry.kind}: ${sanitizeTerminalText(entry.displayPath)} (${sanitizeTerminalText(entry.reason)})`,
      );
    }
  }

  if (result.updatedConfigWorkspacePaths > 0) {
    lines.push(
      `Updated ${result.updatedConfigWorkspacePaths} workspace path${result.updatedConfigWorkspacePaths === 1 ? "" : "s"} in the restored config.`,
    );
  }

  if (result.dryRun) {
    lines.push("Dry run only; no files were written.");
  }

  return lines.join("\n");
}

export async function backupRestoreCommand(
  runtime: RuntimeEnv,
  opts: BackupRestoreOptions,
): Promise<BackupRestoreResult> {
  const archivePath = resolveUserPath(opts.archive);
  const includeWorkspace = opts.includeWorkspace ?? true;
  const workingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-"));
  try {
    const pinnedArchivePath = path.join(workingRoot, "archive.tar.gz");
    await fs.copyFile(archivePath, pinnedArchivePath);

    const restorePlan = await buildRestoreItems({
      archivePath: pinnedArchivePath,
      includeWorkspace,
    });

    await assertRestoreTargetsReady({
      archivePath,
      items: restorePlan.items,
      force: Boolean(opts.force),
    });

    const result: BackupRestoreResult = {
      archivePath,
      createdAt: restorePlan.createdAt,
      runtimeVersion: restorePlan.runtimeVersion,
      dryRun: Boolean(opts.dryRun),
      force: Boolean(opts.force),
      includeWorkspace,
      restored: restorePlan.items.map((item) => ({
        kind: item.kind,
        sourcePath: item.sourcePath,
        targetPath: item.targetPath,
      })),
      skipped: restorePlan.skipped,
      updatedConfigWorkspacePaths: 0,
    };

    if (!opts.dryRun) {
      const stageRoot = path.join(workingRoot, "staged-assets");
      await fs.mkdir(stageRoot, { recursive: true });
      const stagedRestore = await stageRestoreItems({
        archivePath: pinnedArchivePath,
        items: restorePlan.items,
        workspaceRewrites: restorePlan.workspaceRewrites,
        stageRoot,
      });
      await publishRestorePlan(stagedRestore.stagedItems);
      await applyRestorePermissionBaseline();
      result.updatedConfigWorkspacePaths = stagedRestore.updatedConfigWorkspacePaths;
      clearConfigCache();
    }

    runtime.log(opts.json ? JSON.stringify(result, null, 2) : formatRestoreSummary(result));
    return result;
  } finally {
    await fs.rm(workingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
