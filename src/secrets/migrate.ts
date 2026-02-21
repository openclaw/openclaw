import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import {
  createConfigIO,
  resolveStateDir,
  type OpenClawConfig,
  type SecretRef,
} from "../config/config.js";
import { runExec } from "../process/exec.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";

const DEFAULT_SOPS_TIMEOUT_MS = 5_000;
const MAX_SOPS_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_SECRETS_FILE_PATH = "~/.openclaw/secrets.enc.json";
const BACKUP_DIRNAME = "secrets-migrate";
const BACKUP_MANIFEST_FILENAME = "manifest.json";
const BACKUP_RETENTION = 20;

type MigrationCounters = {
  configRefs: number;
  authProfileRefs: number;
  plaintextRemoved: number;
  secretsWritten: number;
  envEntriesRemoved: number;
  authStoresChanged: number;
};

type AuthStoreChange = {
  path: string;
  nextStore: Record<string, unknown>;
};

type EnvChange = {
  path: string;
  nextRaw: string;
};

type BackupManifestEntry = {
  path: string;
  existed: boolean;
  backupPath?: string;
  mode?: number;
};

type BackupManifest = {
  version: 1;
  backupId: string;
  createdAt: string;
  entries: BackupManifestEntry[];
};

type MigrationPlan = {
  changed: boolean;
  counters: MigrationCounters;
  stateDir: string;
  configChanged: boolean;
  nextConfig: OpenClawConfig;
  configWriteOptions: Awaited<
    ReturnType<ReturnType<typeof createConfigIO>["readConfigFileSnapshotForWrite"]>
  >["writeOptions"];
  authStoreChanges: AuthStoreChange[];
  payloadChanged: boolean;
  nextPayload: Record<string, unknown>;
  secretsFilePath: string;
  secretsFileTimeoutMs: number;
  envChange: EnvChange | null;
  backupTargets: string[];
};

export type SecretsMigrationRunOptions = {
  write?: boolean;
  scrubEnv?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: Date;
};

export type SecretsMigrationRunResult = {
  mode: "dry-run" | "write";
  changed: boolean;
  backupId?: string;
  backupDir?: string;
  secretsFilePath: string;
  counters: MigrationCounters;
  changedFiles: string[];
};

export type SecretsMigrationRollbackOptions = {
  backupId: string;
  env?: NodeJS.ProcessEnv;
};

export type SecretsMigrationRollbackResult = {
  backupId: string;
  restoredFiles: number;
  deletedFiles: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretRef(value: unknown): value is SecretRef {
  if (!isRecord(value)) {
    return false;
  }
  if (Object.keys(value).length !== 2) {
    return false;
  }
  return (
    (value.source === "env" || value.source === "file") &&
    typeof value.id === "string" &&
    value.id.trim().length > 0
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSopsTimeoutMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  return DEFAULT_SOPS_TIMEOUT_MS;
}

function decodeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function encodeJsonPointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function readJsonPointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) {
    return undefined;
  }
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => decodeJsonPointerToken(token));

  let current: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(token, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    if (!Object.hasOwn(current, token)) {
      return undefined;
    }
    current = current[token];
  }
  return current;
}

function setJsonPointer(root: Record<string, unknown>, pointer: string, value: unknown): void {
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON pointer "${pointer}".`);
  }
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => decodeJsonPointerToken(token));

  let current: Record<string, unknown> = root;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const isLast = index === tokens.length - 1;
    if (isLast) {
      current[token] = value;
      return;
    }
    const child = current[token];
    if (!isRecord(child)) {
      current[token] = {};
    }
    current = current[token] as Record<string, unknown>;
  }
}

function formatBackupId(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const minute = String(now.getUTCMinutes()).padStart(2, "0");
  const second = String(now.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hour}${minute}${second}Z`;
}

function parseEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function scrubEnvRaw(
  raw: string,
  migratedValues: Set<string>,
): {
  nextRaw: string;
  removed: number;
} {
  if (migratedValues.size === 0) {
    return { nextRaw: raw, removed: 0 };
  }
  const lines = raw.split(/\r?\n/);
  const nextLines: string[] = [];
  let removed = 0;
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      nextLines.push(line);
      continue;
    }
    const parsedValue = parseEnvValue(match[2] ?? "");
    if (migratedValues.has(parsedValue)) {
      removed += 1;
      continue;
    }
    nextLines.push(line);
  }
  const hadTrailingNewline = raw.endsWith("\n");
  const joined = nextLines.join("\n");
  return {
    nextRaw:
      hadTrailingNewline || joined.length === 0
        ? `${joined}${joined.endsWith("\n") ? "" : "\n"}`
        : joined,
    removed,
  };
}

function ensureDirForFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

function saveJsonFile(pathname: string, value: unknown): void {
  ensureDirForFile(pathname);
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
}

function resolveFileSource(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): {
  path: string;
  timeoutMs: number;
  hadConfiguredSource: boolean;
} {
  const source = config.secrets?.sources?.file;
  if (source && source.type === "sops" && isNonEmptyString(source.path)) {
    return {
      path: resolveUserPath(source.path),
      timeoutMs: normalizeSopsTimeoutMs(source.timeoutMs),
      hadConfiguredSource: true,
    };
  }

  return {
    path: resolveUserPath(resolveDefaultSecretsConfigPath(env)),
    timeoutMs: DEFAULT_SOPS_TIMEOUT_MS,
    hadConfiguredSource: false,
  };
}

function resolveDefaultSecretsConfigPath(env: NodeJS.ProcessEnv): string {
  if (env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim()) {
    return path.join(resolveStateDir(env, os.homedir), "secrets.enc.json");
  }
  return DEFAULT_SECRETS_FILE_PATH;
}

async function decryptSopsJson(
  pathname: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  if (!fs.existsSync(pathname)) {
    return {};
  }
  try {
    const { stdout } = await runExec("sops", ["--decrypt", "--output-type", "json", pathname], {
      timeoutMs,
      maxBuffer: MAX_SOPS_OUTPUT_BYTES,
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("decrypted payload is not a JSON object");
    }
    return parsed;
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { message?: string };
    if (error.code === "ENOENT") {
      throw new Error(
        "sops binary not found in PATH. Install sops >= 3.9.0 to run secrets migrate.",
        {
          cause: err,
        },
      );
    }
    if (typeof error.message === "string" && error.message.toLowerCase().includes("timed out")) {
      throw new Error(`sops decrypt timed out after ${timeoutMs}ms for ${pathname}.`, {
        cause: err,
      });
    }
    throw new Error(`sops decrypt failed for ${pathname}: ${String(error.message ?? err)}`, {
      cause: err,
    });
  }
}

async function encryptSopsJson(params: {
  pathname: string;
  timeoutMs: number;
  payload: Record<string, unknown>;
}): Promise<void> {
  ensureDirForFile(params.pathname);
  const tmpPlain = path.join(
    path.dirname(params.pathname),
    `${path.basename(params.pathname)}.${process.pid}.${crypto.randomUUID()}.plain.tmp`,
  );
  const tmpEncrypted = path.join(
    path.dirname(params.pathname),
    `${path.basename(params.pathname)}.${process.pid}.${crypto.randomUUID()}.enc.tmp`,
  );

  fs.writeFileSync(tmpPlain, `${JSON.stringify(params.payload, null, 2)}\n`, "utf8");
  fs.chmodSync(tmpPlain, 0o600);

  try {
    await runExec(
      "sops",
      [
        "--encrypt",
        "--input-type",
        "json",
        "--output-type",
        "json",
        "--output",
        tmpEncrypted,
        tmpPlain,
      ],
      {
        timeoutMs: params.timeoutMs,
        maxBuffer: MAX_SOPS_OUTPUT_BYTES,
      },
    );
    fs.renameSync(tmpEncrypted, params.pathname);
    fs.chmodSync(params.pathname, 0o600);
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { message?: string };
    if (error.code === "ENOENT") {
      throw new Error(
        "sops binary not found in PATH. Install sops >= 3.9.0 to run secrets migrate.",
        {
          cause: err,
        },
      );
    }
    if (typeof error.message === "string" && error.message.toLowerCase().includes("timed out")) {
      throw new Error(
        `sops encrypt timed out after ${params.timeoutMs}ms for ${params.pathname}.`,
        {
          cause: err,
        },
      );
    }
    throw new Error(`sops encrypt failed for ${params.pathname}: ${String(error.message ?? err)}`, {
      cause: err,
    });
  } finally {
    fs.rmSync(tmpPlain, { force: true });
    fs.rmSync(tmpEncrypted, { force: true });
  }
}

function migrateModelProviderSecrets(params: {
  config: OpenClawConfig;
  payload: Record<string, unknown>;
  counters: MigrationCounters;
  migratedValues: Set<string>;
}): void {
  const providers = params.config.models?.providers as
    | Record<string, { apiKey?: unknown }>
    | undefined;
  if (!providers) {
    return;
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    if (isSecretRef(provider.apiKey)) {
      continue;
    }
    if (!isNonEmptyString(provider.apiKey)) {
      continue;
    }
    const value = provider.apiKey.trim();
    const id = `/providers/${encodeJsonPointerToken(providerId)}/apiKey`;
    const existing = readJsonPointer(params.payload, id);
    if (!isDeepStrictEqual(existing, value)) {
      setJsonPointer(params.payload, id, value);
      params.counters.secretsWritten += 1;
    }
    provider.apiKey = { source: "file", id };
    params.counters.configRefs += 1;
    params.migratedValues.add(value);
  }
}

function migrateSkillEntrySecrets(params: {
  config: OpenClawConfig;
  payload: Record<string, unknown>;
  counters: MigrationCounters;
  migratedValues: Set<string>;
}): void {
  const entries = params.config.skills?.entries as Record<string, { apiKey?: unknown }> | undefined;
  if (!entries) {
    return;
  }
  for (const [skillKey, entry] of Object.entries(entries)) {
    if (!isRecord(entry) || isSecretRef(entry.apiKey)) {
      continue;
    }
    if (!isNonEmptyString(entry.apiKey)) {
      continue;
    }
    const value = entry.apiKey.trim();
    const id = `/skills/entries/${encodeJsonPointerToken(skillKey)}/apiKey`;
    const existing = readJsonPointer(params.payload, id);
    if (!isDeepStrictEqual(existing, value)) {
      setJsonPointer(params.payload, id, value);
      params.counters.secretsWritten += 1;
    }
    entry.apiKey = { source: "file", id };
    params.counters.configRefs += 1;
    params.migratedValues.add(value);
  }
}

function migrateGoogleChatServiceAccount(params: {
  account: Record<string, unknown>;
  pointerId: string;
  counters: MigrationCounters;
  payload: Record<string, unknown>;
}): void {
  const explicitRef = isSecretRef(params.account.serviceAccountRef)
    ? params.account.serviceAccountRef
    : null;
  const inlineRef = isSecretRef(params.account.serviceAccount)
    ? params.account.serviceAccount
    : null;
  if (explicitRef || inlineRef) {
    if (
      params.account.serviceAccount !== undefined &&
      !isSecretRef(params.account.serviceAccount)
    ) {
      delete params.account.serviceAccount;
      params.counters.plaintextRemoved += 1;
    }
    return;
  }

  const value = params.account.serviceAccount;
  const hasStringValue = isNonEmptyString(value);
  const hasObjectValue = isRecord(value) && Object.keys(value).length > 0;
  if (!hasStringValue && !hasObjectValue) {
    return;
  }

  const id = `${params.pointerId}/serviceAccount`;
  const normalizedValue = hasStringValue ? value.trim() : structuredClone(value);
  const existing = readJsonPointer(params.payload, id);
  if (!isDeepStrictEqual(existing, normalizedValue)) {
    setJsonPointer(params.payload, id, normalizedValue);
    params.counters.secretsWritten += 1;
  }

  params.account.serviceAccountRef = { source: "file", id };
  delete params.account.serviceAccount;
  params.counters.configRefs += 1;
}

function migrateGoogleChatSecrets(params: {
  config: OpenClawConfig;
  payload: Record<string, unknown>;
  counters: MigrationCounters;
}): void {
  const googlechat = params.config.channels?.googlechat;
  if (!isRecord(googlechat)) {
    return;
  }

  migrateGoogleChatServiceAccount({
    account: googlechat,
    pointerId: "/channels/googlechat",
    payload: params.payload,
    counters: params.counters,
  });

  if (!isRecord(googlechat.accounts)) {
    return;
  }
  for (const [accountId, accountValue] of Object.entries(googlechat.accounts)) {
    if (!isRecord(accountValue)) {
      continue;
    }
    migrateGoogleChatServiceAccount({
      account: accountValue,
      pointerId: `/channels/googlechat/accounts/${encodeJsonPointerToken(accountId)}`,
      payload: params.payload,
      counters: params.counters,
    });
  }
}

function collectAuthStorePaths(config: OpenClawConfig, stateDir: string): string[] {
  const paths = new Set<string>();
  paths.add(resolveUserPath(resolveAuthStorePath()));

  const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      paths.add(path.join(agentsRoot, entry.name, "agent", "auth-profiles.json"));
    }
  }

  for (const agentId of listAgentIds(config)) {
    const agentDir = resolveAgentDir(config, agentId);
    paths.add(resolveUserPath(resolveAuthStorePath(agentDir)));
  }

  return [...paths];
}

function deriveAuthStoreScope(authStorePath: string, stateDir: string): string {
  const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
  const relative = path.relative(agentsRoot, authStorePath);
  if (!relative.startsWith("..")) {
    const segments = relative.split(path.sep);
    if (segments.length >= 3 && segments[1] === "agent" && segments[2] === "auth-profiles.json") {
      const candidate = segments[0]?.trim();
      if (candidate) {
        return candidate;
      }
    }
  }

  const digest = crypto.createHash("sha1").update(authStorePath).digest("hex").slice(0, 8);
  return `path-${digest}`;
}

function migrateAuthStoreSecrets(params: {
  store: Record<string, unknown>;
  scope: string;
  payload: Record<string, unknown>;
  counters: MigrationCounters;
  migratedValues: Set<string>;
}): boolean {
  const profiles = params.store.profiles;
  if (!isRecord(profiles)) {
    return false;
  }

  let changed = false;
  for (const [profileId, profileValue] of Object.entries(profiles)) {
    if (!isRecord(profileValue)) {
      continue;
    }
    if (profileValue.type === "api_key") {
      const keyRef = isSecretRef(profileValue.keyRef) ? profileValue.keyRef : null;
      const key = isNonEmptyString(profileValue.key) ? profileValue.key.trim() : "";
      if (keyRef) {
        if (key) {
          delete profileValue.key;
          params.counters.plaintextRemoved += 1;
          changed = true;
        }
        continue;
      }
      if (!key) {
        continue;
      }
      const id = `/auth-profiles/${encodeJsonPointerToken(params.scope)}/${encodeJsonPointerToken(profileId)}/key`;
      const existing = readJsonPointer(params.payload, id);
      if (!isDeepStrictEqual(existing, key)) {
        setJsonPointer(params.payload, id, key);
        params.counters.secretsWritten += 1;
      }
      profileValue.keyRef = { source: "file", id };
      delete profileValue.key;
      params.counters.authProfileRefs += 1;
      params.migratedValues.add(key);
      changed = true;
      continue;
    }

    if (profileValue.type === "token") {
      const tokenRef = isSecretRef(profileValue.tokenRef) ? profileValue.tokenRef : null;
      const token = isNonEmptyString(profileValue.token) ? profileValue.token.trim() : "";
      if (tokenRef) {
        if (token) {
          delete profileValue.token;
          params.counters.plaintextRemoved += 1;
          changed = true;
        }
        continue;
      }
      if (!token) {
        continue;
      }
      const id = `/auth-profiles/${encodeJsonPointerToken(params.scope)}/${encodeJsonPointerToken(profileId)}/token`;
      const existing = readJsonPointer(params.payload, id);
      if (!isDeepStrictEqual(existing, token)) {
        setJsonPointer(params.payload, id, token);
        params.counters.secretsWritten += 1;
      }
      profileValue.tokenRef = { source: "file", id };
      delete profileValue.token;
      params.counters.authProfileRefs += 1;
      params.migratedValues.add(token);
      changed = true;
    }
  }

  return changed;
}

function resolveBackupRoot(stateDir: string): string {
  return path.join(resolveUserPath(stateDir), "backups", BACKUP_DIRNAME);
}

function createBackupManifest(params: {
  stateDir: string;
  targets: string[];
  backupId: string;
  now: Date;
}): { backupDir: string; manifestPath: string; manifest: BackupManifest } {
  const backupDir = path.join(resolveBackupRoot(params.stateDir), params.backupId);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const entries: BackupManifestEntry[] = [];
  let index = 0;
  for (const target of params.targets) {
    const normalized = resolveUserPath(target);
    const exists = fs.existsSync(normalized);
    if (!exists) {
      entries.push({ path: normalized, existed: false });
      continue;
    }

    const backupName = `file-${String(index).padStart(4, "0")}.bak`;
    const backupPath = path.join(backupDir, backupName);
    fs.copyFileSync(normalized, backupPath);
    const stats = fs.statSync(normalized);
    entries.push({
      path: normalized,
      existed: true,
      backupPath,
      mode: stats.mode & 0o777,
    });
    index += 1;
  }

  const manifest: BackupManifest = {
    version: 1,
    backupId: params.backupId,
    createdAt: params.now.toISOString(),
    entries,
  };
  const manifestPath = path.join(backupDir, BACKUP_MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.chmodSync(manifestPath, 0o600);

  return { backupDir, manifestPath, manifest };
}

function restoreFromManifest(manifest: BackupManifest): {
  restoredFiles: number;
  deletedFiles: number;
} {
  let restoredFiles = 0;
  let deletedFiles = 0;

  for (const entry of manifest.entries) {
    if (!entry.existed) {
      if (fs.existsSync(entry.path)) {
        fs.rmSync(entry.path, { force: true });
        deletedFiles += 1;
      }
      continue;
    }

    if (!entry.backupPath || !fs.existsSync(entry.backupPath)) {
      throw new Error(`Backup file is missing for ${entry.path}.`);
    }
    ensureDirForFile(entry.path);
    fs.copyFileSync(entry.backupPath, entry.path);
    fs.chmodSync(entry.path, entry.mode ?? 0o600);
    restoredFiles += 1;
  }

  return { restoredFiles, deletedFiles };
}

function pruneOldBackups(stateDir: string): void {
  const backupRoot = resolveBackupRoot(stateDir);
  if (!fs.existsSync(backupRoot)) {
    return;
  }
  const dirs = fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

  if (dirs.length <= BACKUP_RETENTION) {
    return;
  }

  const toDelete = dirs.slice(0, Math.max(0, dirs.length - BACKUP_RETENTION));
  for (const dir of toDelete) {
    fs.rmSync(path.join(backupRoot, dir), { recursive: true, force: true });
  }
}

async function buildMigrationPlan(params: {
  env: NodeJS.ProcessEnv;
  scrubEnv: boolean;
}): Promise<MigrationPlan> {
  const io = createConfigIO({ env: params.env });
  const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    const issues =
      snapshot.issues.length > 0
        ? snapshot.issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("\n")
        : "Unknown validation issue.";
    throw new Error(`Cannot migrate secrets because config is invalid:\n${issues}`);
  }

  const stateDir = resolveStateDir(params.env, os.homedir);
  const nextConfig = structuredClone(snapshot.config);
  const fileSource = resolveFileSource(nextConfig, params.env);
  const previousPayload = await decryptSopsJson(fileSource.path, fileSource.timeoutMs);
  const nextPayload = structuredClone(previousPayload);

  const counters: MigrationCounters = {
    configRefs: 0,
    authProfileRefs: 0,
    plaintextRemoved: 0,
    secretsWritten: 0,
    envEntriesRemoved: 0,
    authStoresChanged: 0,
  };

  const migratedValues = new Set<string>();

  migrateModelProviderSecrets({
    config: nextConfig,
    payload: nextPayload,
    counters,
    migratedValues,
  });
  migrateSkillEntrySecrets({
    config: nextConfig,
    payload: nextPayload,
    counters,
    migratedValues,
  });
  migrateGoogleChatSecrets({
    config: nextConfig,
    payload: nextPayload,
    counters,
  });

  const authStoreChanges: AuthStoreChange[] = [];
  for (const authStorePath of collectAuthStorePaths(nextConfig, stateDir)) {
    if (!fs.existsSync(authStorePath)) {
      continue;
    }
    const raw = fs.readFileSync(authStorePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }

    const nextStore = structuredClone(parsed);
    const scope = deriveAuthStoreScope(authStorePath, stateDir);
    const changed = migrateAuthStoreSecrets({
      store: nextStore,
      scope,
      payload: nextPayload,
      counters,
      migratedValues,
    });
    if (!changed) {
      continue;
    }
    authStoreChanges.push({ path: authStorePath, nextStore });
  }
  counters.authStoresChanged = authStoreChanges.length;

  if (counters.secretsWritten > 0 && !fileSource.hadConfiguredSource) {
    const defaultConfigPath = resolveDefaultSecretsConfigPath(params.env);
    nextConfig.secrets ??= {};
    nextConfig.secrets.sources ??= {};
    nextConfig.secrets.sources.file = {
      type: "sops",
      path: defaultConfigPath,
      timeoutMs: DEFAULT_SOPS_TIMEOUT_MS,
    };
  }

  const configChanged = !isDeepStrictEqual(snapshot.config, nextConfig);
  const payloadChanged = !isDeepStrictEqual(previousPayload, nextPayload);

  let envChange: EnvChange | null = null;
  if (params.scrubEnv && migratedValues.size > 0) {
    const envPath = path.join(resolveConfigDir(params.env, os.homedir), ".env");
    if (fs.existsSync(envPath)) {
      const rawEnv = fs.readFileSync(envPath, "utf8");
      const scrubbed = scrubEnvRaw(rawEnv, migratedValues);
      if (scrubbed.removed > 0 && scrubbed.nextRaw !== rawEnv) {
        counters.envEntriesRemoved = scrubbed.removed;
        envChange = {
          path: envPath,
          nextRaw: scrubbed.nextRaw,
        };
      }
    }
  }

  const backupTargets = new Set<string>();
  if (configChanged) {
    backupTargets.add(io.configPath);
  }
  if (payloadChanged) {
    backupTargets.add(fileSource.path);
  }
  for (const change of authStoreChanges) {
    backupTargets.add(change.path);
  }
  if (envChange) {
    backupTargets.add(envChange.path);
  }

  return {
    changed: configChanged || payloadChanged || authStoreChanges.length > 0 || Boolean(envChange),
    counters,
    stateDir,
    configChanged,
    nextConfig,
    configWriteOptions: writeOptions,
    authStoreChanges,
    payloadChanged,
    nextPayload,
    secretsFilePath: fileSource.path,
    secretsFileTimeoutMs: fileSource.timeoutMs,
    envChange,
    backupTargets: [...backupTargets],
  };
}

export async function runSecretsMigration(
  options: SecretsMigrationRunOptions = {},
): Promise<SecretsMigrationRunResult> {
  const env = options.env ?? process.env;
  const scrubEnv = options.scrubEnv ?? true;
  const plan = await buildMigrationPlan({ env, scrubEnv });

  if (!options.write) {
    return {
      mode: "dry-run",
      changed: plan.changed,
      secretsFilePath: plan.secretsFilePath,
      counters: plan.counters,
      changedFiles: plan.backupTargets,
    };
  }

  if (!plan.changed) {
    return {
      mode: "write",
      changed: false,
      secretsFilePath: plan.secretsFilePath,
      counters: plan.counters,
      changedFiles: [],
    };
  }

  const now = options.now ?? new Date();
  const backupId = formatBackupId(now);
  const backup = createBackupManifest({
    stateDir: plan.stateDir,
    targets: plan.backupTargets,
    backupId,
    now,
  });

  try {
    if (plan.payloadChanged) {
      await encryptSopsJson({
        pathname: plan.secretsFilePath,
        timeoutMs: plan.secretsFileTimeoutMs,
        payload: plan.nextPayload,
      });
    }

    if (plan.configChanged) {
      const io = createConfigIO({ env });
      await io.writeConfigFile(plan.nextConfig, plan.configWriteOptions);
    }

    for (const change of plan.authStoreChanges) {
      saveJsonFile(change.path, change.nextStore);
    }

    if (plan.envChange) {
      ensureDirForFile(plan.envChange.path);
      fs.writeFileSync(plan.envChange.path, plan.envChange.nextRaw, "utf8");
      fs.chmodSync(plan.envChange.path, 0o600);
    }
  } catch (err) {
    restoreFromManifest(backup.manifest);
    throw new Error(
      `Secrets migration failed and was rolled back from backup ${backupId}: ${String(err)}`,
      {
        cause: err,
      },
    );
  }

  pruneOldBackups(plan.stateDir);

  return {
    mode: "write",
    changed: true,
    backupId,
    backupDir: backup.backupDir,
    secretsFilePath: plan.secretsFilePath,
    counters: plan.counters,
    changedFiles: plan.backupTargets,
  };
}

export function resolveSecretsMigrationBackupRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBackupRoot(resolveStateDir(env, os.homedir));
}

export function listSecretsMigrationBackups(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = resolveSecretsMigrationBackupRoot(env);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

export async function rollbackSecretsMigration(
  options: SecretsMigrationRollbackOptions,
): Promise<SecretsMigrationRollbackResult> {
  const env = options.env ?? process.env;
  const backupDir = path.join(resolveSecretsMigrationBackupRoot(env), options.backupId);
  const manifestPath = path.join(backupDir, BACKUP_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    const available = listSecretsMigrationBackups(env);
    const suffix =
      available.length > 0
        ? ` Available backups: ${available.slice(-10).join(", ")}`
        : " No backups were found.";
    throw new Error(`Backup "${options.backupId}" was not found.${suffix}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`Failed to read backup manifest at ${manifestPath}: ${String(err)}`, {
      cause: err,
    });
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    throw new Error(`Backup manifest at ${manifestPath} is invalid.`);
  }

  const manifest = parsed as BackupManifest;
  const restored = restoreFromManifest(manifest);
  return {
    backupId: options.backupId,
    restoredFiles: restored.restoredFiles,
    deletedFiles: restored.deletedFiles,
  };
}
