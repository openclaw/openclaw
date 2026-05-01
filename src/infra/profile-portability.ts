import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
  resolveStateDir,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveInstalledPluginIndexStorePath } from "../plugins/installed-plugin-index-store-path.js";
import { refreshPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

const PROFILE_ARCHIVE_SCHEMA_VERSION = 1;
const PROFILE_ARCHIVE_KIND = "openclaw-profile";
const PROFILE_PLUGIN_INSTALLS_SCHEMA_VERSION = 1;
const PROFILE_ROOT_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "BOOT.md",
  "MEMORY.md",
] as const;
const PROFILE_SAFE_CONFIG_KEYS = ["ui", "skills", "tools", "memory", "mcp"] as const;
const PROFILE_CONFIG_DICTIONARY_KEYS = new Set([
  "cliBackends",
  "entries",
  "models",
  "providerOptions",
  "servers",
]);
const PROFILE_SECRET_CONFIG_KEYS = new Set([
  "apikey",
  "auth",
  "authorization",
  "credentials",
  "encryptkey",
  "encryptionkey",
  "env",
  "headers",
  "oauth",
  "password",
  "privatekey",
  "secret",
  "token",
]);
const PROFILE_LOCAL_PATH_CONFIG_KEYS = new Set([
  "cwd",
  "dir",
  "dirs",
  "exportdir",
  "extradirs",
  "path",
  "paths",
  "workdir",
  "workingdirectory",
]);
const WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const PROFILE_PORTABLE_PLUGIN_INSTALL_SOURCES = new Set(["npm", "clawhub", "marketplace"]);
const PROFILE_PORTABLE_PLUGIN_STRING_FIELDS = [
  "spec",
  "version",
  "resolvedName",
  "resolvedVersion",
  "resolvedSpec",
  "integrity",
  "shasum",
  "clawhubPackage",
  "marketplaceName",
  "marketplaceSource",
  "marketplacePlugin",
] as const;
const PROFILE_CLAWHUB_FAMILIES = new Set(["code-plugin", "bundle-plugin"]);
const PROFILE_CLAWHUB_CHANNELS = new Set(["official", "community", "private"]);

type ProfileArchiveAssetKind = "config" | "workspace-file" | "plugin-installs";

type ProfileArchiveAsset = {
  kind: ProfileArchiveAssetKind;
  archivePath: string;
  agentId?: string;
  relativePath?: string;
};

type ProfileArchiveManifest = {
  schemaVersion: 1;
  archiveKind: typeof PROFILE_ARCHIVE_KIND;
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  configPaths: string[];
  assets: ProfileArchiveAsset[];
  skipped: Array<{
    kind: string;
    agentId?: string;
    relativePath?: string;
    reason: string;
  }>;
};

type ProfileWorkspaceFile = {
  agentId: string;
  sourcePath: string;
  relativePath: string;
  archivePath: string;
};

type ProfileSkippedEntry = {
  kind: string;
  agentId?: string;
  relativePath?: string;
  reason: string;
};

type ProfileConfigMergeResult = {
  config: OpenClawConfig;
  appliedPaths: string[];
  skippedPaths: string[];
};

type ProfilePluginInstallsPayload = {
  schemaVersion: typeof PROFILE_PLUGIN_INSTALLS_SCHEMA_VERSION;
  archiveKind: typeof PROFILE_ARCHIVE_KIND;
  records: Record<string, PluginInstallRecord>;
};

export type ProfileExportOptions = {
  output?: string;
  dryRun?: boolean;
  verify?: boolean;
  json?: boolean;
  nowMs?: number;
};

export type ProfileExportResult = {
  createdAt: string;
  archiveRoot: string;
  archivePath: string;
  dryRun: boolean;
  verified: boolean;
  configPaths: string[];
  workspaceFiles: Array<{ agentId: string; relativePath: string }>;
  pluginInstalls: boolean;
  skipped: ProfileSkippedEntry[];
};

export type ProfileImportOptions = {
  archive: string;
  dryRun?: boolean;
  json?: boolean;
};

export type ProfileImportResult = {
  archivePath: string;
  archiveRoot: string;
  dryRun: boolean;
  configAppliedPaths: string[];
  configSkippedPaths: string[];
  filesWritten: Array<{
    kind: string;
    agentId?: string;
    relativePath?: string;
    targetPath: string;
  }>;
  filesWouldWrite: Array<{
    kind: string;
    agentId?: string;
    relativePath?: string;
    targetPath: string;
  }>;
  filesSkipped: Array<{
    kind: string;
    agentId?: string;
    relativePath?: string;
    targetPath?: string;
    reason: string;
  }>;
};

function cloneConfig<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatUnknownForMessage(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  return JSON.stringify(value) ?? typeof value;
}

function isPortablePluginInstallSource(source: unknown): source is PluginInstallRecord["source"] {
  return typeof source === "string" && PROFILE_PORTABLE_PLUGIN_INSTALL_SOURCES.has(source);
}

function isLocalPathLikeValue(value: string): boolean {
  const normalized = value.trim();
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE.test(normalized)
  ) {
    return true;
  }
  try {
    const parsed = new URL(normalized);
    return (
      parsed.protocol === "file:" ||
      Boolean(parsed.username) ||
      Boolean(parsed.password) ||
      Boolean(parsed.search)
    );
  } catch {
    return false;
  }
}

function readPortablePluginString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string" || isLocalPathLikeValue(value)) {
    return undefined;
  }
  return value;
}

function sanitizePluginInstallRecord(record: unknown): PluginInstallRecord | null {
  if (!isRecord(record) || !isPortablePluginInstallSource(record.source)) {
    return null;
  }
  const portableRecord: Record<string, unknown> = { source: record.source };
  for (const key of PROFILE_PORTABLE_PLUGIN_STRING_FIELDS) {
    const value = readPortablePluginString(record, key);
    if (value !== undefined) {
      portableRecord[key] = value;
    }
  }
  if (
    typeof record.clawhubFamily === "string" &&
    PROFILE_CLAWHUB_FAMILIES.has(record.clawhubFamily)
  ) {
    portableRecord.clawhubFamily = record.clawhubFamily;
  }
  if (
    typeof record.clawhubChannel === "string" &&
    PROFILE_CLAWHUB_CHANNELS.has(record.clawhubChannel)
  ) {
    portableRecord.clawhubChannel = record.clawhubChannel;
  }
  const hasPortableIdentity =
    typeof portableRecord.spec === "string" ||
    typeof portableRecord.resolvedName === "string" ||
    typeof portableRecord.clawhubPackage === "string" ||
    typeof portableRecord.marketplacePlugin === "string";
  return hasPortableIdentity ? (portableRecord as PluginInstallRecord) : null;
}

function extractPluginInstallRecordCandidates(parsed: unknown): Record<string, unknown> {
  if (!isRecord(parsed)) {
    return {};
  }
  if (parsed.archiveKind !== undefined && parsed.archiveKind !== PROFILE_ARCHIVE_KIND) {
    throw new Error(
      `Unsupported plugin install records archive kind: ${formatUnknownForMessage(
        parsed.archiveKind,
      )}`,
    );
  }
  if (
    parsed.schemaVersion !== undefined &&
    parsed.schemaVersion !== PROFILE_PLUGIN_INSTALLS_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported plugin install records schemaVersion: ${formatUnknownForMessage(
        parsed.schemaVersion,
      )}`,
    );
  }
  if (isRecord(parsed.records)) {
    return parsed.records;
  }
  if (isRecord(parsed.installRecords)) {
    return parsed.installRecords;
  }
  const records: Record<string, unknown> = {};
  if (Array.isArray(parsed.plugins)) {
    for (const entry of parsed.plugins) {
      if (isRecord(entry) && typeof entry.pluginId === "string" && isRecord(entry.installRecord)) {
        records[entry.pluginId] = entry.installRecord;
      }
    }
  }
  return records;
}

function sanitizePluginInstallRecordsPayload(raw: string): Record<string, PluginInstallRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Plugin install records payload is not valid JSON: ${String(err)}`, {
      cause: err,
    });
  }
  const records: Record<string, PluginInstallRecord> = {};
  const candidates = extractPluginInstallRecordCandidates(parsed);
  for (const [pluginId, record] of Object.entries(candidates).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (isBlockedObjectKey(pluginId)) {
      continue;
    }
    const portableRecord = sanitizePluginInstallRecord(record);
    if (portableRecord) {
      records[pluginId] = portableRecord;
    }
  }
  return records;
}

function buildProfilePluginInstallsPayload(
  records: Record<string, PluginInstallRecord>,
): ProfilePluginInstallsPayload {
  return {
    schemaVersion: PROFILE_PLUGIN_INSTALLS_SCHEMA_VERSION,
    archiveKind: PROFILE_ARCHIVE_KIND,
    records,
  };
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function normalizeProfileConfigKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

function shouldOmitPortableConfigKey(key: string): boolean {
  const normalized = normalizeProfileConfigKey(key);
  return (
    PROFILE_SECRET_CONFIG_KEYS.has(normalized) ||
    PROFILE_LOCAL_PATH_CONFIG_KEYS.has(normalized) ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("authorization") ||
    normalized.endsWith("credentials") ||
    normalized.endsWith("encryptkey") ||
    normalized.endsWith("encryptionkey") ||
    normalized.endsWith("oauth") ||
    normalized.endsWith("password") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token")
  );
}

function isDictionaryConfigPath(pathSegments: string[]): boolean {
  const parentKey = pathSegments.at(-1);
  return Boolean(parentKey && PROFILE_CONFIG_DICTIONARY_KEYS.has(parentKey));
}

function sanitizePortableConfigValue(
  value: unknown,
  pathSegments: string[] = [],
  insideDictionaryValue = false,
): unknown {
  if (Array.isArray(value)) {
    const sanitizedEntries: unknown[] = [];
    for (const entry of value) {
      const sanitized = sanitizePortableConfigValue(
        entry,
        [...pathSegments, "[]"],
        insideDictionaryValue,
      );
      if (sanitized !== undefined) {
        sanitizedEntries.push(sanitized);
      }
    }
    return sanitizedEntries;
  }
  if (!isRecord(value)) {
    return cloneConfig(value);
  }
  const result: Record<string, unknown> = {};
  const keysAreDictionaryIds = !insideDictionaryValue && isDictionaryConfigPath(pathSegments);
  for (const [key, child] of Object.entries(value)) {
    if (!keysAreDictionaryIds && shouldOmitPortableConfigKey(key)) {
      continue;
    }
    const sanitized = sanitizePortableConfigValue(
      child,
      [...pathSegments, key],
      keysAreDictionaryIds,
    );
    if (sanitized !== undefined) {
      result[key] = sanitized;
    }
  }
  return result;
}

function normalizeArchivePath(entryPath: string, label: string): string {
  const trimmed = stripTrailingSlashes(entryPath.trim());
  if (!trimmed) {
    throw new Error(`${label} is empty.`);
  }
  if (trimmed.startsWith("/") || WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE.test(trimmed)) {
    throw new Error(`${label} must be relative: ${entryPath}`);
  }
  if (trimmed.includes("\\")) {
    throw new Error(`${label} must use forward slashes: ${entryPath}`);
  }
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} contains path traversal segments: ${entryPath}`);
  }
  const normalized = stripTrailingSlashes(path.posix.normalize(trimmed));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} resolves outside the archive root: ${entryPath}`);
  }
  return normalized;
}

function isArchivePathWithin(child: string, parent: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === "" || (!relative.startsWith("../") && relative !== "..");
}

function isRootManifestEntry(entryPath: string): boolean {
  const parts = entryPath.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] === "manifest.json";
}

function buildProfileArchiveRoot(nowMs: number): string {
  return `${new Date(nowMs).toISOString().replaceAll(":", "-")}-openclaw-profile`;
}

function buildProfileArchiveBasename(nowMs: number): string {
  return `${buildProfileArchiveRoot(nowMs)}.openclaw-profile.tar.gz`;
}

async function resolveProfileOutputPath(params: {
  output?: string;
  nowMs: number;
}): Promise<string> {
  const basename = buildProfileArchiveBasename(params.nowMs);
  const rawOutput = params.output?.trim();
  if (!rawOutput) {
    return path.resolve(process.cwd(), basename);
  }
  const resolved = path.resolve(rawOutput.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (rawOutput.endsWith("/") || rawOutput.endsWith("\\")) {
    return path.join(resolved, basename);
  }
  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return path.join(resolved, basename);
    }
  } catch {
    // Missing output is treated as an archive file path.
  }
  return resolved;
}

async function assertNoExistingPath(outputPath: string): Promise<void> {
  try {
    await fs.access(outputPath);
    throw new Error(`Refusing to overwrite existing profile archive: ${outputPath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return;
    }
    throw err;
  }
}

function isLinkUnsupportedError(code: string | undefined): boolean {
  return code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EPERM";
}

async function publishTempArchive(params: {
  tempArchivePath: string;
  outputPath: string;
}): Promise<void> {
  try {
    await fs.link(params.tempArchivePath, params.outputPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing profile archive: ${params.outputPath}`, {
        cause: err,
      });
    }
    if (!isLinkUnsupportedError(code)) {
      throw err;
    }
    await fs.copyFile(params.tempArchivePath, params.outputPath, fsConstants.COPYFILE_EXCL);
  }
  await fs.rm(params.tempArchivePath, { force: true });
}

function sanitizeAgentsConfig(agents: OpenClawConfig["agents"]): OpenClawConfig["agents"] {
  if (!agents || typeof agents !== "object") {
    return undefined;
  }
  const next = cloneConfig(agents);
  if (next.defaults) {
    delete next.defaults.workspace;
    delete next.defaults.repoRoot;
  }
  if (Array.isArray(next.list)) {
    const sanitizedList: NonNullable<OpenClawConfig["agents"]>["list"] = [];
    for (const entry of next.list) {
      const agent = cloneConfig(entry);
      delete agent.workspace;
      delete agent.agentDir;
      if (agent.runtime?.type === "acp" && agent.runtime.acp) {
        delete agent.runtime.acp.cwd;
      }
      sanitizedList.push(agent);
    }
    next.list = sanitizedList;
  }
  return sanitizePortableConfigValue(next, ["agents"]) as OpenClawConfig["agents"];
}

export function buildSafeProfileConfig(config: OpenClawConfig): OpenClawConfig {
  const result: OpenClawConfig = {};
  for (const key of PROFILE_SAFE_CONFIG_KEYS) {
    if (config[key] !== undefined) {
      result[key] = sanitizePortableConfigValue(config[key], [key]) as never;
    }
  }
  const agents = sanitizeAgentsConfig(config.agents);
  if (agents) {
    result.agents = agents;
  }
  if (config.plugins?.entries || config.plugins?.slots) {
    result.plugins = {};
    if (config.plugins.entries) {
      result.plugins.entries = sanitizePortableConfigValue(config.plugins.entries, [
        "plugins",
        "entries",
      ]) as NonNullable<OpenClawConfig["plugins"]>["entries"];
    }
    if (config.plugins.slots) {
      result.plugins.slots = cloneConfig(config.plugins.slots);
    }
  }
  return result;
}

function collectConfigPaths(config: OpenClawConfig): string[] {
  const paths: string[] = [];
  for (const key of PROFILE_SAFE_CONFIG_KEYS) {
    if (config[key] !== undefined) {
      paths.push(key);
    }
  }
  if (config.agents !== undefined) {
    paths.push("agents");
  }
  if (config.plugins?.entries !== undefined) {
    paths.push("plugins.entries");
  }
  if (config.plugins?.slots !== undefined) {
    paths.push("plugins.slots");
  }
  return paths;
}

async function maybeAddWorkspaceRootFile(params: {
  files: ProfileWorkspaceFile[];
  skipped: ProfileSkippedEntry[];
  archiveRoot: string;
  workspaceDir: string;
  agentId: string;
  fileName: string;
}): Promise<void> {
  const filePath = path.join(params.workspaceDir, params.fileName);
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat) {
    return;
  }
  if (!stat.isFile()) {
    params.skipped.push({
      kind: "workspace-file",
      agentId: params.agentId,
      relativePath: params.fileName,
      reason: stat.isSymbolicLink() ? "symlink" : "not-file",
    });
    return;
  }
  params.files.push({
    agentId: params.agentId,
    sourcePath: filePath,
    relativePath: params.fileName,
    archivePath: path.posix.join(
      params.archiveRoot,
      "payload",
      "workspaces",
      params.agentId,
      params.fileName,
    ),
  });
}

async function collectMemoryFiles(params: {
  files: ProfileWorkspaceFile[];
  skipped: ProfileSkippedEntry[];
  archiveRoot: string;
  workspaceDir: string;
  agentId: string;
  relativeDir?: string;
}): Promise<void> {
  const relativeDir = params.relativeDir ?? "memory";
  const absDir = path.join(params.workspaceDir, relativeDir);
  const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return;
  }
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDir.replaceAll("\\", "/"), entry.name);
    const absPath = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      await collectMemoryFiles({ ...params, relativeDir: relativePath });
      continue;
    }
    if (!entry.isFile()) {
      params.skipped.push({
        kind: "workspace-file",
        agentId: params.agentId,
        relativePath,
        reason: entry.isSymbolicLink() ? "symlink" : "not-file",
      });
      continue;
    }
    if (!entry.name.endsWith(".md")) {
      continue;
    }
    params.files.push({
      agentId: params.agentId,
      sourcePath: absPath,
      relativePath,
      archivePath: path.posix.join(
        params.archiveRoot,
        "payload",
        "workspaces",
        params.agentId,
        relativePath,
      ),
    });
  }
}

async function collectWorkspaceFiles(params: {
  cfg: OpenClawConfig;
  archiveRoot: string;
}): Promise<{ files: ProfileWorkspaceFile[]; skipped: ProfileSkippedEntry[] }> {
  const files: ProfileWorkspaceFile[] = [];
  const skipped: ProfileSkippedEntry[] = [];
  const seen = new Set<string>();
  for (const agentId of listAgentIds(params.cfg)) {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    for (const fileName of PROFILE_ROOT_FILE_NAMES) {
      await maybeAddWorkspaceRootFile({
        files,
        skipped,
        archiveRoot: params.archiveRoot,
        workspaceDir,
        agentId,
        fileName,
      });
    }
    await collectMemoryFiles({
      files,
      skipped,
      archiveRoot: params.archiveRoot,
      workspaceDir,
      agentId,
    });
  }
  return {
    files: files.filter((file) => {
      const key = `${file.agentId}\0${file.relativePath}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }),
    skipped,
  };
}

async function readOptionalFile(pathname: string): Promise<string | null> {
  try {
    return await fs.readFile(pathname, "utf8");
  } catch {
    return null;
  }
}

function buildProfileManifest(params: {
  createdAt: string;
  archiveRoot: string;
  configPaths: string[];
  workspaceFiles: ProfileWorkspaceFile[];
  hasPluginInstalls: boolean;
  skipped: ProfileSkippedEntry[];
}): ProfileArchiveManifest {
  const assets: ProfileArchiveAsset[] = [
    {
      kind: "config",
      archivePath: path.posix.join(params.archiveRoot, "payload", "config", "openclaw.json"),
    },
    ...params.workspaceFiles.map((file) => ({
      kind: "workspace-file" as const,
      archivePath: file.archivePath,
      agentId: file.agentId,
      relativePath: file.relativePath,
    })),
  ];
  if (params.hasPluginInstalls) {
    assets.push({
      kind: "plugin-installs",
      archivePath: path.posix.join(params.archiveRoot, "payload", "plugins", "installs.json"),
    });
  }
  return {
    schemaVersion: PROFILE_ARCHIVE_SCHEMA_VERSION,
    archiveKind: PROFILE_ARCHIVE_KIND,
    createdAt: params.createdAt,
    archiveRoot: params.archiveRoot,
    runtimeVersion: resolveRuntimeServiceVersion(),
    platform: process.platform,
    nodeVersion: process.version,
    configPaths: params.configPaths,
    assets,
    skipped: params.skipped,
  };
}

function remapProfileArchiveEntry(params: {
  entryPath: string;
  pathMap: Map<string, string>;
}): string {
  return params.pathMap.get(path.resolve(params.entryPath)) ?? params.entryPath;
}

export async function createProfileArchive(
  opts: ProfileExportOptions = {},
): Promise<ProfileExportResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const archiveRoot = buildProfileArchiveRoot(nowMs);
  const outputPath = await resolveProfileOutputPath({ output: opts.output, nowMs });
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(`Config invalid at ${snapshot.path}; cannot export a profile archive.`);
  }
  const safeConfig = buildSafeProfileConfig(snapshot.sourceConfig);
  const configPaths = collectConfigPaths(safeConfig);
  const { files: workspaceFiles, skipped } = await collectWorkspaceFiles({
    cfg: snapshot.config,
    archiveRoot,
  });
  const pluginInstallsPath = resolveInstalledPluginIndexStorePath({
    stateDir: resolveStateDir(process.env),
  });
  const pluginInstallsRaw = await readOptionalFile(pluginInstallsPath);
  const pluginInstallRecords =
    pluginInstallsRaw === null ? {} : sanitizePluginInstallRecordsPayload(pluginInstallsRaw);
  const hasPluginInstalls = Object.keys(pluginInstallRecords).length > 0;
  const createdAt = new Date(nowMs).toISOString();
  const result: ProfileExportResult = {
    createdAt,
    archiveRoot,
    archivePath: outputPath,
    dryRun: Boolean(opts.dryRun),
    verified: false,
    configPaths,
    workspaceFiles: workspaceFiles.map((file) => ({
      agentId: file.agentId,
      relativePath: file.relativePath,
    })),
    pluginInstalls: hasPluginInstalls,
    skipped,
  };
  if (opts.dryRun) {
    return result;
  }
  await assertNoExistingPath(outputPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-profile-"));
  const tempArchivePath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    const manifestPath = path.join(tempDir, "manifest.json");
    const configPath = path.join(tempDir, "openclaw.json");
    const pluginPayloadPath = path.join(tempDir, "installs.json");
    const manifest = buildProfileManifest({
      createdAt,
      archiveRoot,
      configPaths,
      workspaceFiles,
      hasPluginInstalls,
      skipped,
    });
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.writeFile(configPath, `${JSON.stringify(safeConfig, null, 2)}\n`, "utf8");
    if (hasPluginInstalls) {
      await fs.writeFile(
        pluginPayloadPath,
        `${JSON.stringify(buildProfilePluginInstallsPayload(pluginInstallRecords), null, 2)}\n`,
        "utf8",
      );
    }

    const pathMap = new Map<string, string>([
      [path.resolve(manifestPath), path.posix.join(archiveRoot, "manifest.json")],
      [
        path.resolve(configPath),
        path.posix.join(archiveRoot, "payload", "config", "openclaw.json"),
      ],
      [
        path.resolve(pluginPayloadPath),
        path.posix.join(archiveRoot, "payload", "plugins", "installs.json"),
      ],
      ...workspaceFiles.map((file) => [path.resolve(file.sourcePath), file.archivePath] as const),
    ]);
    const entries = [
      manifestPath,
      configPath,
      ...(hasPluginInstalls ? [pluginPayloadPath] : []),
      ...workspaceFiles.map((file) => file.sourcePath),
    ];
    await tar.c(
      {
        file: tempArchivePath,
        gzip: true,
        portable: true,
        preservePaths: true,
        onWriteEntry: (entry) => {
          entry.path = remapProfileArchiveEntry({ entryPath: entry.path, pathMap });
        },
      },
      entries,
    );
    await publishTempArchive({ tempArchivePath, outputPath });
  } finally {
    await fs.rm(tempArchivePath, { force: true }).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
  if (opts.verify) {
    await readProfileArchive(outputPath);
    result.verified = true;
  }
  return result;
}

function parseManifest(raw: string): ProfileArchiveManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Profile manifest is not valid JSON: ${String(err)}`, { cause: err });
  }
  if (!isRecord(parsed)) {
    throw new Error("Profile manifest must be an object.");
  }
  if (parsed.schemaVersion !== PROFILE_ARCHIVE_SCHEMA_VERSION) {
    throw new Error(`Unsupported profile manifest schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (parsed.archiveKind !== PROFILE_ARCHIVE_KIND) {
    throw new Error(`Unsupported profile archive kind: ${String(parsed.archiveKind)}`);
  }
  if (typeof parsed.archiveRoot !== "string" || !parsed.archiveRoot.trim()) {
    throw new Error("Profile manifest is missing archiveRoot.");
  }
  if (!Array.isArray(parsed.assets)) {
    throw new Error("Profile manifest is missing assets.");
  }
  const archiveRoot = normalizeArchivePath(parsed.archiveRoot, "Profile manifest archiveRoot");
  if (archiveRoot.includes("/")) {
    throw new Error(`Profile manifest archiveRoot must be a single path segment: ${archiveRoot}`);
  }
  const assets: ProfileArchiveAsset[] = parsed.assets.map((asset) => {
    if (!isRecord(asset)) {
      throw new Error("Profile manifest contains a non-object asset.");
    }
    const kind = asset.kind;
    if (kind !== "config" && kind !== "workspace-file" && kind !== "plugin-installs") {
      throw new Error(`Unsupported profile manifest asset kind: ${String(kind)}`);
    }
    const archivePath =
      typeof asset.archivePath === "string"
        ? normalizeArchivePath(asset.archivePath, "Profile manifest asset path")
        : "";
    if (!archivePath) {
      throw new Error("Profile manifest asset is missing archivePath.");
    }
    return {
      kind,
      archivePath,
      agentId: typeof asset.agentId === "string" ? asset.agentId : undefined,
      relativePath: typeof asset.relativePath === "string" ? asset.relativePath : undefined,
    };
  });
  return {
    schemaVersion: PROFILE_ARCHIVE_SCHEMA_VERSION,
    archiveKind: PROFILE_ARCHIVE_KIND,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    archiveRoot,
    runtimeVersion: typeof parsed.runtimeVersion === "string" ? parsed.runtimeVersion : "unknown",
    platform: process.platform,
    nodeVersion: typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : "unknown",
    configPaths: Array.isArray(parsed.configPaths)
      ? parsed.configPaths.filter((entry): entry is string => typeof entry === "string")
      : [],
    assets,
    skipped: Array.isArray(parsed.skipped)
      ? parsed.skipped.filter(isRecord).map((entry) => ({
          kind: typeof entry.kind === "string" ? entry.kind : "unknown",
          agentId: typeof entry.agentId === "string" ? entry.agentId : undefined,
          relativePath: typeof entry.relativePath === "string" ? entry.relativePath : undefined,
          reason: typeof entry.reason === "string" ? entry.reason : "unknown",
        }))
      : [],
  };
}

async function readProfileArchive(archivePath: string): Promise<{
  manifest: ProfileArchiveManifest;
  contents: Map<string, Buffer>;
}> {
  const rawEntries: string[] = [];
  const contents = new Map<string, Buffer>();
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      const normalized = normalizeArchivePath(entry.path, "Profile archive entry");
      rawEntries.push(normalized);
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      entry.on("end", () => {
        contents.set(normalized, Buffer.concat(chunks));
      });
    },
  });
  const manifestMatches = rawEntries.filter(isRootManifestEntry);
  if (manifestMatches.length !== 1) {
    throw new Error(
      `Expected exactly one profile manifest entry, found ${manifestMatches.length}.`,
    );
  }
  const seen = new Set<string>();
  for (const entry of rawEntries) {
    if (seen.has(entry)) {
      throw new Error(`Profile archive contains duplicate entry path: ${entry}`);
    }
    seen.add(entry);
  }
  const manifestPath = manifestMatches[0];
  const manifestRaw = contents.get(manifestPath)?.toString("utf8");
  if (!manifestRaw) {
    throw new Error(`Profile archive is missing manifest entry: ${manifestPath}`);
  }
  const manifest = parseManifest(manifestRaw);
  const entries = new Set(rawEntries);
  for (const entry of entries) {
    if (!isArchivePathWithin(entry, manifest.archiveRoot)) {
      throw new Error(`Profile archive entry is outside the declared archive root: ${entry}`);
    }
  }
  for (const asset of manifest.assets) {
    if (!isArchivePathWithin(asset.archivePath, path.posix.join(manifest.archiveRoot, "payload"))) {
      throw new Error(`Profile manifest asset is outside payload root: ${asset.archivePath}`);
    }
    if (!entries.has(asset.archivePath)) {
      throw new Error(`Profile archive is missing payload for asset: ${asset.archivePath}`);
    }
  }
  return { manifest, contents };
}

function assignIfMissing(params: {
  target: Record<string, unknown>;
  key: string;
  value: unknown;
  pathLabel: string;
  applied: string[];
  skipped: string[];
}): void {
  if (params.value === undefined) {
    return;
  }
  if (params.target[params.key] === undefined) {
    params.target[params.key] = cloneConfig(params.value);
    params.applied.push(params.pathLabel);
    return;
  }
  params.skipped.push(params.pathLabel);
}

export function mergeMissingProfileConfig(
  baseConfig: OpenClawConfig,
  profileConfig: OpenClawConfig,
): ProfileConfigMergeResult {
  const config = cloneConfig(baseConfig);
  const appliedPaths: string[] = [];
  const skippedPaths: string[] = [];
  const configRecord = config as Record<string, unknown>;
  const profileRecord = profileConfig as Record<string, unknown>;
  for (const key of PROFILE_SAFE_CONFIG_KEYS) {
    assignIfMissing({
      target: configRecord,
      key,
      value: profileRecord[key],
      pathLabel: key,
      applied: appliedPaths,
      skipped: skippedPaths,
    });
  }

  if (profileConfig.agents) {
    if (!config.agents) {
      config.agents = cloneConfig(profileConfig.agents);
      appliedPaths.push("agents");
    } else {
      if (profileConfig.agents.defaults) {
        config.agents.defaults ??= {};
        const defaults = config.agents.defaults as Record<string, unknown>;
        for (const [key, value] of Object.entries(profileConfig.agents.defaults)) {
          assignIfMissing({
            target: defaults,
            key,
            value,
            pathLabel: `agents.defaults.${key}`,
            applied: appliedPaths,
            skipped: skippedPaths,
          });
        }
      }
      if (Array.isArray(profileConfig.agents.list) && profileConfig.agents.list.length > 0) {
        config.agents.list ??= [];
        const existingIds = new Set(config.agents.list.map((agent) => agent.id));
        for (const agent of profileConfig.agents.list) {
          if (existingIds.has(agent.id)) {
            skippedPaths.push(`agents.list.${agent.id}`);
            continue;
          }
          config.agents.list.push(cloneConfig(agent));
          existingIds.add(agent.id);
          appliedPaths.push(`agents.list.${agent.id}`);
        }
      }
    }
  }

  if (profileConfig.plugins?.entries || profileConfig.plugins?.slots) {
    config.plugins ??= {};
    if (profileConfig.plugins.entries) {
      config.plugins.entries ??= {};
      for (const [pluginId, entry] of Object.entries(profileConfig.plugins.entries)) {
        assignIfMissing({
          target: config.plugins.entries as Record<string, unknown>,
          key: pluginId,
          value: entry,
          pathLabel: `plugins.entries.${pluginId}`,
          applied: appliedPaths,
          skipped: skippedPaths,
        });
      }
    }
    if (profileConfig.plugins.slots) {
      config.plugins.slots ??= {};
      for (const [slot, value] of Object.entries(profileConfig.plugins.slots)) {
        assignIfMissing({
          target: config.plugins.slots as Record<string, unknown>,
          key: slot,
          value,
          pathLabel: `plugins.slots.${slot}`,
          applied: appliedPaths,
          skipped: skippedPaths,
        });
      }
    }
  }

  return { config, appliedPaths, skippedPaths };
}

function parseProfileConfig(raw: Buffer | undefined): OpenClawConfig {
  if (!raw) {
    throw new Error("Profile archive is missing config payload.");
  }
  const parsed = JSON.parse(raw.toString("utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Profile config payload must be an object.");
  }
  return buildSafeProfileConfig(parsed as OpenClawConfig);
}

function parseProfilePluginInstallRecords(
  raw: Buffer | undefined,
): Record<string, PluginInstallRecord> {
  if (!raw) {
    throw new Error("Profile archive is missing plugin install records payload.");
  }
  return sanitizePluginInstallRecordsPayload(raw.toString("utf8"));
}

function resolveSafeWorkspaceTarget(params: {
  workspaceDir: string;
  relativePath: string;
}): string {
  const normalizedRelative = normalizeArchivePath(params.relativePath, "Profile workspace path");
  const isMemoryFile =
    normalizedRelative.startsWith("memory/") && normalizedRelative.endsWith(".md");
  if (isMemoryFile || PROFILE_ROOT_FILE_NAMES.includes(normalizedRelative as never)) {
    const targetPath = path.resolve(params.workspaceDir, normalizedRelative);
    const relative = path.relative(path.resolve(params.workspaceDir), targetPath);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Profile workspace path escapes target workspace: ${params.relativePath}`);
    }
    return targetPath;
  }
  throw new Error(`Profile workspace file is not importable: ${params.relativePath}`);
}

export async function importProfileArchive(
  opts: ProfileImportOptions,
): Promise<ProfileImportResult> {
  const archivePath = path.resolve(opts.archive.replace(/^~(?=$|[\\/])/, os.homedir()));
  const { manifest, contents } = await readProfileArchive(archivePath);
  const configAsset = manifest.assets.find((asset) => asset.kind === "config");
  if (!configAsset) {
    throw new Error("Profile manifest is missing config asset.");
  }
  const profileConfig = parseProfileConfig(contents.get(configAsset.archivePath));
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  const configMerge = mergeMissingProfileConfig(snapshot.sourceConfig, profileConfig);
  if (!opts.dryRun && configMerge.appliedPaths.length > 0) {
    await replaceConfigFile({
      nextConfig: configMerge.config,
      snapshot,
      writeOptions,
      afterWrite: { mode: "auto" },
    });
  }

  const filesWritten: ProfileImportResult["filesWritten"] = [];
  const filesWouldWrite: ProfileImportResult["filesWouldWrite"] = [];
  const filesSkipped: ProfileImportResult["filesSkipped"] = [];
  for (const asset of manifest.assets) {
    if (asset.kind === "config") {
      continue;
    }
    if (asset.kind === "plugin-installs") {
      const installRecords = parseProfilePluginInstallRecords(contents.get(asset.archivePath));
      const targetPath = resolveInstalledPluginIndexStorePath({ stateDir: resolveStateDir() });
      if (await pathExists(targetPath)) {
        filesSkipped.push({ kind: asset.kind, targetPath, reason: "exists" });
        continue;
      }
      if (Object.keys(installRecords).length === 0) {
        filesSkipped.push({ kind: asset.kind, targetPath, reason: "empty" });
        continue;
      }
      if (!opts.dryRun) {
        await refreshPersistedInstalledPluginIndex({
          stateDir: resolveStateDir(),
          reason: "source-changed",
          installRecords,
        });
        filesWritten.push({ kind: asset.kind, targetPath });
      } else {
        filesWouldWrite.push({ kind: asset.kind, targetPath });
      }
      continue;
    }
    const agentId = asset.agentId;
    const relativePath = asset.relativePath;
    if (!agentId || !relativePath) {
      filesSkipped.push({
        kind: asset.kind,
        agentId,
        relativePath,
        reason: "missing-metadata",
      });
      continue;
    }
    const workspaceDir = resolveAgentWorkspaceDir(configMerge.config, agentId);
    const targetPath = resolveSafeWorkspaceTarget({ workspaceDir, relativePath });
    if (await pathExists(targetPath)) {
      filesSkipped.push({ kind: asset.kind, agentId, relativePath, targetPath, reason: "exists" });
      continue;
    }
    if (!opts.dryRun) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(targetPath, contents.get(asset.archivePath) ?? Buffer.alloc(0), "utf8");
      filesWritten.push({ kind: asset.kind, agentId, relativePath, targetPath });
    } else {
      filesWouldWrite.push({ kind: asset.kind, agentId, relativePath, targetPath });
    }
  }

  return {
    archivePath,
    archiveRoot: manifest.archiveRoot,
    dryRun: Boolean(opts.dryRun),
    configAppliedPaths: configMerge.appliedPaths,
    configSkippedPaths: configMerge.skippedPaths,
    filesWritten,
    filesWouldWrite,
    filesSkipped,
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function formatProfileExportSummary(result: ProfileExportResult): string[] {
  const lines = [`Profile archive: ${result.archivePath}`];
  lines.push(`Config paths: ${result.configPaths.length}`);
  lines.push(`Workspace files: ${result.workspaceFiles.length}`);
  lines.push(`Plugin install records: ${result.pluginInstalls ? "included" : "not found"}`);
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length} path${result.skipped.length === 1 ? "" : "s"}.`);
  }
  if (result.dryRun) {
    lines.push("Dry run only; archive was not written.");
  } else {
    lines.push(`Created ${result.archivePath}`);
    if (result.verified) {
      lines.push("Archive verification: passed");
    }
  }
  return lines;
}

export function formatProfileImportSummary(result: ProfileImportResult): string[] {
  const lines = [`Profile archive: ${result.archivePath}`];
  lines.push(`Config paths applied: ${result.configAppliedPaths.length}`);
  lines.push(`Config paths skipped: ${result.configSkippedPaths.length}`);
  if (result.dryRun) {
    lines.push(`Files would write: ${result.filesWouldWrite.length}`);
  } else {
    lines.push(`Files written: ${result.filesWritten.length}`);
  }
  lines.push(`Files skipped: ${result.filesSkipped.length}`);
  if (result.dryRun) {
    lines.push("Dry run only; profile was not imported.");
  }
  return lines;
}
