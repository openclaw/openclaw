// CLI config readiness guard, legacy-state migration routing, and invalid-config allowances.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withSuppressedNotes } from "../../../packages/terminal-core/src/note.js";
import { readConfigFileSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveLegacyStateDirs, resolveOAuthDir, resolveStateDir } from "../../config/paths.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../config/sessions/targets.js";
import type { ConfigFileSnapshot } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveHomeRelativePath,
  resolveRequiredHomeDir,
  resolveRequiredOsHomeDir,
} from "../../infra/home-dir.js";
import { readSessionStoreJson5 } from "../../infra/state-migrations.fs.js";
import type { OpenKeyedStoreOptions } from "../../plugin-state/plugin-state-store.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/account-id.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../../sessions/session-key-utils.js";
import { shouldMigrateStateFromPath } from "../argv.js";

const ALLOWED_INVALID_COMMANDS = new Set(["doctor", "logs", "health", "help", "status"]);
const ALLOWED_INVALID_GATEWAY_SUBCOMMANDS = new Set([
  "run",
  "status",
  "probe",
  "health",
  "discover",
  "call",
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
]);
const ALLOWED_INVALID_TASK_SUBCOMMANDS = new Set(["list", "audit"]);
let didRunDoctorConfigFlow = false;
let configSnapshotPromise: Promise<Awaited<ReturnType<typeof readConfigFileSnapshot>>> | null =
  null;

function resetConfigGuardStateForTests() {
  didRunDoctorConfigFlow = false;
  configSnapshotPromise = null;
}

function fileOrDirExists(pathname: string): boolean {
  try {
    return fs.existsSync(pathname);
  } catch {
    return false;
  }
}

function dirHasFile(dir: string, predicate: (name: string) => boolean): boolean {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isFile() && predicate(entry.name));
  } catch {
    return false;
  }
}

function dirHasDescendantFile(dir: string, predicate: (name: string) => boolean): boolean {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => {
      if (entry.isFile()) {
        return predicate(entry.name);
      }
      return entry.isDirectory() && dirHasDescendantFile(path.join(dir, entry.name), predicate);
    });
  } catch {
    return false;
  }
}

function isLegacyWhatsAppAuthFile(name: string): boolean {
  if (name === "creds.json" || name === "creds.json.bak") {
    return true;
  }
  return name.endsWith(".json") && /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
}

function isLegacyTelegramStateFile(name: string): boolean {
  return (
    (name.startsWith("bot-info-") && name.endsWith(".json")) ||
    (name.startsWith("update-offset-") && name.endsWith(".json")) ||
    name === "sticker-cache.json" ||
    (name.startsWith("thread-bindings-") && name.endsWith(".json"))
  );
}

function hasLegacyIMessageStateFiles(stateDir: string): boolean {
  return (
    fileOrDirExists(path.join(stateDir, "imessage", "reply-cache.jsonl")) ||
    fileOrDirExists(path.join(stateDir, "imessage", "sent-echoes.jsonl")) ||
    dirHasFile(path.join(stateDir, "imessage", "catchup"), (name) => name.endsWith(".json"))
  );
}

function hasBundledChannelLegacyStateMigrationInputs(stateDir: string, oauthDir: string): boolean {
  if (
    fileOrDirExists(path.join(stateDir, "discord", "model-picker-preferences.json")) ||
    fileOrDirExists(path.join(stateDir, "discord", "thread-bindings.json"))
  ) {
    return true;
  }
  if (dirHasFile(path.join(stateDir, "feishu", "dedup"), (name) => name.endsWith(".json"))) {
    return true;
  }
  if (hasLegacyIMessageStateFiles(stateDir)) {
    return true;
  }
  if (
    fileOrDirExists(path.join(oauthDir, "telegram-allowFrom.json")) ||
    dirHasFile(path.join(stateDir, "telegram"), isLegacyTelegramStateFile)
  ) {
    return true;
  }
  return dirHasFile(oauthDir, isLegacyWhatsAppAuthFile);
}

function hasLegacyDeliveryQueueMigrationInput(stateDir: string): boolean {
  const queueDirs = ["delivery-queue", "session-delivery-queue"].map((dirName) =>
    path.join(stateDir, dirName),
  );
  return queueDirs.some(
    (queueDir) =>
      dirHasFile(queueDir, (name) => name.endsWith(".json") || name.endsWith(".delivered")) ||
      dirHasFile(path.join(queueDir, "failed"), (name) => name.endsWith(".json")),
  );
}

function hasLegacyDebugProxyCaptureInput(stateDir: string): boolean {
  const sourcePath =
    process.env.OPENCLAW_DEBUG_PROXY_DB_PATH?.trim() ||
    path.join(stateDir, "debug-proxy", "capture.sqlite");
  if (path.resolve(sourcePath) === path.resolve(path.join(stateDir, "state", "openclaw.sqlite"))) {
    return false;
  }
  const blobDir =
    process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR?.trim() ||
    path.join(stateDir, "debug-proxy", "blobs");
  return (
    fileOrDirExists(sourcePath) ||
    (fileOrDirExists(`${sourcePath}.migrated`) &&
      (["-shm", "-wal", "-journal"].some((suffix) => fileOrDirExists(`${sourcePath}${suffix}`)) ||
        fileOrDirExists(blobDir)))
  );
}

function hasLegacyStateJsonMigrationInput(stateDir: string): boolean {
  return [
    path.join(stateDir, "settings", "voicewake.json"),
    path.join(stateDir, "settings", "voicewake-routing.json"),
    path.join(stateDir, "update-check.json"),
    path.join(stateDir, "logs", "config-health.json"),
    path.join(stateDir, "bindings", "current-conversations.json"),
  ].some(fileOrDirExists);
}

function resolveConfigDirForStartupDetection(): string {
  const stateOverride = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    return resolveConfiguredPath(stateOverride);
  }
  const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) {
    return path.dirname(resolveConfiguredPath(configPath));
  }
  return path.join(resolveRequiredHomeDir(process.env, os.homedir), ".openclaw");
}

function resolveCronStorePathForStartupDetection(store?: unknown): string {
  const rawStore = typeof store === "string" ? store.trim() : "";
  if (rawStore) {
    return resolveConfiguredPath(rawStore);
  }
  return path.join(resolveConfigDirForStartupDetection(), "cron", "jobs.json");
}

function resolveLegacyCronStatePath(storePath: string): string {
  return storePath.endsWith(".json")
    ? storePath.replace(/\.json$/, "-state.json")
    : `${storePath}-state.json`;
}

function hasLegacyCronMigrationInputForStore(storePath: string): boolean {
  return (
    fileOrDirExists(storePath) ||
    fileOrDirExists(resolveLegacyCronStatePath(storePath)) ||
    dirHasFile(path.join(path.dirname(storePath), "runs"), (name) => name.endsWith(".jsonl"))
  );
}

async function hasSharedStateDatabaseLegacyMigrationInput(stateDir: string): Promise<boolean> {
  const stateDbPath = path.join(stateDir, "state", "openclaw.sqlite");
  if (!fileOrDirExists(stateDbPath)) {
    return false;
  }
  try {
    const [{ requireNodeSqlite }, { detectOpenClawStateDatabaseSchemaMigrations }] =
      await Promise.all([
        import("../../infra/node-sqlite.js"),
        import("../../state/openclaw-state-db.js"),
      ]);
    if (
      detectOpenClawStateDatabaseSchemaMigrations({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }).length > 0
    ) {
      return true;
    }
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(stateDbPath, { readOnly: true });
    try {
      const hasPluginStateTable = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plugin_state_entries'",
        )
        .get();
      if (!hasPluginStateTable) {
        return false;
      }
      return Boolean(
        db
          .prepare(
            `SELECT 1
               FROM plugin_state_entries
              WHERE (plugin_id = 'workboard'
                     AND namespace IN (
                       'workboard.cards',
                       'workboard.boards',
                       'workboard.notify',
                       'workboard.attachments'
                     ))
                 OR (plugin_id = 'telegram'
                     AND namespace = 'telegram.message-dispatch-dedupe')
              LIMIT 1`,
          )
          .get(),
      );
    } finally {
      db.close();
    }
  } catch {
    // If the cheap schema/KV probe cannot run, keep the conservative behavior
    // and let the doctor preflight own the user-facing migration/error path.
    return true;
  }
}

function hasMatrixLegacyStateMigrationInput(stateDir: string): boolean {
  const matrixLegacyFilenames = new Set([
    "storage-meta.json",
    "bot-storage.json",
    "recovery-key.json",
    "crypto-idb-snapshot.json",
    "legacy-crypto-migration.json",
  ]);
  return dirHasDescendantFile(path.join(stateDir, "matrix"), (name) =>
    matrixLegacyFilenames.has(name),
  );
}

function hasNostrLegacyStateMigrationInput(stateDir: string): boolean {
  return dirHasFile(
    path.join(stateDir, "nostr"),
    (name) =>
      (name.startsWith("bus-state-") || name.startsWith("profile-state-")) &&
      name.endsWith(".json"),
  );
}

function hasShippedPluginLegacyStateMigrationInput(stateDir: string): boolean {
  const osHomeDir = resolveRequiredOsHomeDir(process.env, os.homedir);
  return (
    fileOrDirExists(path.join(stateDir, "plugins", "active-memory", "session-toggles.json")) ||
    fileOrDirExists(path.join(stateDir, "plugins", "phone-control", "armed.json")) ||
    fileOrDirExists(path.join(stateDir, "gateway-instance-id")) ||
    fileOrDirExists(path.join(stateDir, "device-pair-notify.json")) ||
    dirHasFile(path.join(stateDir, "acpx"), (name) => name.endsWith(".json")) ||
    hasMatrixLegacyStateMigrationInput(stateDir) ||
    hasNostrLegacyStateMigrationInput(stateDir) ||
    ["msteams-conversations.json", "msteams-polls.json", "msteams-sso-tokens.json"].some((name) =>
      fileOrDirExists(path.join(stateDir, name)),
    ) ||
    fileOrDirExists(path.join(osHomeDir, ".openclaw", "voice-calls", "calls.jsonl"))
  );
}

function hasLegacyExecApprovalsMigrationInput(stateDir: string): boolean {
  if (!process.env.OPENCLAW_STATE_DIR?.trim()) {
    return false;
  }
  const homeDir = resolveRequiredHomeDir(process.env, os.homedir);
  const sourcePath = path.join(homeDir, ".openclaw", "exec-approvals.json");
  const targetPath = path.join(stateDir, "exec-approvals.json");
  return (
    path.resolve(sourcePath) !== path.resolve(targetPath) &&
    fileOrDirExists(sourcePath) &&
    !fileOrDirExists(targetPath)
  );
}

function hasPendingSqliteSidecarArchive(sourcePath: string): boolean {
  return (
    fileOrDirExists(`${sourcePath}.migrated`) &&
    ["-shm", "-wal", "-journal"].some((suffix) => fileOrDirExists(`${sourcePath}${suffix}`))
  );
}

async function hasLegacyStateMigrationInputs(): Promise<boolean> {
  // Only run migration prompts when old state actually exists in known legacy locations.
  const stateDir = resolveStateDir(process.env, os.homedir);
  const oauthDir = resolveOAuthDir(process.env, stateDir);
  if (
    !process.env.OPENCLAW_STATE_DIR?.trim() &&
    resolveLegacyStateDirs(() => resolveRequiredHomeDir(process.env, os.homedir)).some(
      fileOrDirExists,
    )
  ) {
    return true;
  }
  const sqliteSidecarPaths = [
    path.join(stateDir, "flows", "registry.sqlite"),
    path.join(stateDir, "plugin-state", "state.sqlite"),
    path.join(stateDir, "tasks", "runs.sqlite"),
  ];
  return (
    [
      path.join(stateDir, "agent"),
      path.join(stateDir, "plugins", "installs.json"),
      path.join(stateDir, "sessions"),
    ].some(fileOrDirExists) ||
    sqliteSidecarPaths.some(
      (sourcePath) => fileOrDirExists(sourcePath) || hasPendingSqliteSidecarArchive(sourcePath),
    ) ||
    hasBundledChannelLegacyStateMigrationInputs(stateDir, oauthDir) ||
    hasLegacyDeliveryQueueMigrationInput(stateDir) ||
    hasLegacyDebugProxyCaptureInput(stateDir) ||
    hasLegacyStateJsonMigrationInput(stateDir) ||
    hasLegacyCronMigrationInputForStore(resolveCronStorePathForStartupDetection()) ||
    hasShippedPluginLegacyStateMigrationInput(stateDir) ||
    fileOrDirExists(
      path.join(
        resolveRequiredHomeDir(process.env, os.homedir),
        ".openclaw",
        "plugin-binding-approvals.json",
      ),
    ) ||
    hasLegacyExecApprovalsMigrationInput(stateDir) ||
    (await hasSharedStateDatabaseLegacyMigrationInput(stateDir))
  );
}

function shouldRunStateMigrationOnlyWithLegacyInputs(commandPath: string[]): boolean {
  const commandName = commandPath[0];
  const subcommandName = commandPath[1];
  return (
    commandName === "agent" ||
    commandName === "status" ||
    (commandName === "gateway" && (subcommandName === undefined || subcommandName === "run")) ||
    (commandName === "tasks" &&
      (subcommandName === undefined || ALLOWED_INVALID_TASK_SUBCOMMANDS.has(subcommandName)))
  );
}

function snapshotHasConfiguredSessionStore(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): boolean {
  const cfg = snapshot.runtimeConfig ?? snapshot.config;
  const store = cfg?.session?.store;
  return typeof store === "string" && store.trim().length > 0;
}

function readSessionStoreObjectForStartupDetection(
  storePath: string,
): Record<string, Record<string, unknown>> | null {
  const parsed = readSessionStoreJson5(storePath);
  return parsed.ok ? (parsed.store as Record<string, Record<string, unknown>>) : null;
}

function canonicalizeSessionKeyForStartupDetection(params: {
  cfg: unknown;
  agentId: string;
  key: string;
  skipCrossAgentRemap?: boolean;
}): string {
  const raw = params.key.trim();
  if (!raw) {
    return raw;
  }
  const rawLower = raw.toLowerCase();
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(raw);
  if (rawLower === "global" || rawLower === "unknown") {
    return rawLower;
  }
  const session = objectRecord(objectRecord(params.cfg)?.session);
  const mainKey = typeof session?.mainKey === "string" ? session.mainKey : undefined;
  const scope = session?.scope === "global" ? "global" : undefined;
  if (params.skipCrossAgentRemap) {
    const parsed = parseAgentSessionKey(raw);
    if (parsed && normalizeAgentId(parsed.agentId) !== params.agentId) {
      return normalized;
    }
    if (params.agentId !== "main" && (rawLower === "main" || rawLower === (mainKey ?? "main"))) {
      return rawLower;
    }
  }
  const canonicalMain = canonicalizeMainSessionAlias({
    cfg: { session: { scope, mainKey } },
    agentId: params.agentId,
    sessionKey: raw,
  });
  if (canonicalMain !== raw) {
    return canonicalMain.toLowerCase();
  }
  if (rawLower.startsWith("agent:")) {
    return normalized;
  }
  if (rawLower.startsWith("subagent:")) {
    const rest = raw.slice("subagent:".length);
    return `agent:${params.agentId}:subagent:${rest}`.toLowerCase();
  }
  if (rawLower.startsWith("group:") || rawLower.startsWith("channel:")) {
    return `agent:${params.agentId}:unknown:${raw}`.toLowerCase();
  }
  return normalizeSessionKeyPreservingOpaquePeerIds(`agent:${params.agentId}:${raw}`);
}

function hasLegacySessionKeyForStartupDetection(params: {
  cfg: unknown;
  agentId: string;
  key: string;
  skipCrossAgentRemap?: boolean;
}): boolean {
  return canonicalizeSessionKeyForStartupDetection(params) !== params.key;
}

function hasAcpSessionMetadataForStartupDetection(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  return Boolean((entry as { acp?: unknown }).acp);
}

function listDirEntriesForStartupDetection(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function hasStaleSessionFileForStartupDetection(params: {
  entry: unknown;
  legacyDir: string;
  targetDir: string;
}): boolean {
  if (!params.entry || typeof params.entry !== "object" || Array.isArray(params.entry)) {
    return false;
  }
  const entry = params.entry as { sessionFile?: unknown; sessionId?: unknown };
  const rawSessionFile = entry.sessionFile;
  if (typeof rawSessionFile !== "string" || !rawSessionFile.trim()) {
    return false;
  }
  const legacySessionFile = path.isAbsolute(rawSessionFile)
    ? path.resolve(rawSessionFile)
    : path.resolve(params.legacyDir, rawSessionFile);
  const relative = path.relative(path.resolve(params.legacyDir), legacySessionFile);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    fileOrDirExists(legacySessionFile)
  ) {
    return false;
  }
  const legacyBackupHasTranscript = listDirEntriesForStartupDetection(
    path.dirname(params.legacyDir),
  ).some(
    (dirent) =>
      dirent.isDirectory() &&
      dirent.name.startsWith(`${path.basename(params.legacyDir)}.legacy-`) &&
      fileOrDirExists(
        path.join(path.dirname(params.legacyDir), dirent.name, path.basename(legacySessionFile)),
      ),
  );
  if (legacyBackupHasTranscript) {
    return false;
  }
  const parsed = path.parse(path.basename(legacySessionFile));
  const hasCollisionRename = listDirEntriesForStartupDetection(params.targetDir).some(
    (dirent) =>
      dirent.isFile() &&
      dirent.name.startsWith(`${parsed.name}.legacy-`) &&
      dirent.name.endsWith(parsed.ext),
  );
  if (hasCollisionRename) {
    return false;
  }
  const targetSessionFile = path.join(params.targetDir, path.basename(legacySessionFile));
  if (!fileOrDirExists(targetSessionFile) || typeof entry.sessionId !== "string") {
    return false;
  }
  try {
    const fd = fs.openSync(targetSessionFile, "r");
    let firstLine: string | undefined;
    try {
      const buffer = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (bytesRead > 0) {
        const chunk = buffer.subarray(0, bytesRead).toString("utf8");
        const newline = chunk.indexOf("\n");
        firstLine = newline >= 0 ? chunk.slice(0, newline) : chunk;
      }
    } finally {
      fs.closeSync(fd);
    }
    const header = firstLine ? (JSON.parse(firstLine) as unknown) : undefined;
    if (!header || typeof header !== "object" || Array.isArray(header)) {
      return false;
    }
    if ((header as { type?: unknown }).type === "session") {
      return (header as { id?: unknown }).id === entry.sessionId;
    }
    const canonicalFileName =
      path.basename(entry.sessionId) === entry.sessionId ? `${entry.sessionId}.jsonl` : undefined;
    return canonicalFileName === path.basename(targetSessionFile);
  } catch {
    return false;
  }
}

function snapshotHasCanonicalSessionMigrationState(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): boolean {
  const cfg = (objectRecord(snapshot.runtimeConfig ?? snapshot.config) ?? {}) as OpenClawConfig;
  const session = objectRecord(objectRecord(cfg)?.session);
  const configuredStore =
    typeof session?.store === "string" && session.store.trim() ? session.store : undefined;
  const targets = new Map<string, { agentId: string; storePath: string }>();
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg, { env: process.env })) {
    targets.set(`${target.storePath}\0${target.agentId}`, target);
  }
  for (const agentId of listConfiguredAgentIdsForSessionMigrationDetection(cfg)) {
    const storePath = resolveSessionStorePathForStartupDetection(configuredStore, agentId);
    targets.set(`${storePath}\0${agentId}`, { agentId, storePath });
  }
  const agentIdsByStorePath = new Map<string, Set<string>>();
  for (const target of targets.values()) {
    const ids = agentIdsByStorePath.get(target.storePath) ?? new Set<string>();
    ids.add(target.agentId);
    agentIdsByStorePath.set(target.storePath, ids);
  }
  const shouldSkipCrossAgentRemap = (storePath: string) => {
    const ids = agentIdsByStorePath.get(storePath);
    return (ids?.size ?? 0) > 1 && ids?.has("main") === true;
  };
  return [...targets.values()].some((target) => {
    const store = readSessionStoreObjectForStartupDetection(target.storePath);
    if (!store) {
      return false;
    }
    const targetDir = path.dirname(target.storePath);
    const legacyDir = path.join(resolveStateDir(process.env, os.homedir), "sessions");
    return Object.entries(store).some(
      ([key, entry]) =>
        hasLegacySessionKeyForStartupDetection({
          cfg,
          agentId: target.agentId,
          key,
          skipCrossAgentRemap: shouldSkipCrossAgentRemap(target.storePath),
        }) ||
        hasAcpSessionMetadataForStartupDetection(entry) ||
        hasStaleSessionFileForStartupDetection({ entry, legacyDir, targetDir }),
    );
  });
}

function snapshotHasConfiguredCronLegacyState(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): boolean {
  const cfg = snapshot.runtimeConfig ?? snapshot.config;
  const cron = objectRecord(cfg?.cron);
  return hasLegacyCronMigrationInputForStore(resolveCronStorePathForStartupDetection(cron?.store));
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeSessionAgentIdForDetection(value: unknown): string {
  return normalizeAgentId(typeof value === "string" ? value : undefined);
}

function listAgentIdsForSessionStoreDetection(cfg: unknown): string[] {
  const ids = new Set<string>(["main"]);
  for (const id of listConfiguredAgentIdsForSessionMigrationDetection(cfg)) {
    ids.add(id);
  }
  return [...ids];
}

function listConfiguredAgentIdsForSessionMigrationDetection(cfg: unknown): string[] {
  const agents = objectRecord(objectRecord(cfg)?.agents);
  const list = Array.isArray(agents?.list) ? agents.list : [];
  if (list.length === 0) {
    return ["main"];
  }
  const ids = new Set<string>();
  for (const entry of list) {
    const record = objectRecord(entry);
    const id = normalizeSessionAgentIdForDetection(record?.id);
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

function resolveSessionStorePathForStartupDetection(store: string | undefined, agentId: string) {
  const normalizedAgentId = normalizeSessionAgentIdForDetection(agentId);
  if (!store) {
    return path.join(
      resolveStateDir(process.env, os.homedir),
      "agents",
      normalizedAgentId,
      "sessions",
      "sessions.json",
    );
  }
  const expanded = store.includes("{agentId}")
    ? store.replaceAll("{agentId}", normalizedAgentId)
    : store;
  return resolveHomeRelativePath(expanded, { env: process.env, homedir: os.homedir });
}

function listMSTeamsFeedbackLearningScanDirs(storePath: string): string[] {
  return [path.resolve(storePath)];
}

function hasMSTeamsFeedbackLearningLegacyState(cfg: unknown): boolean {
  const session = objectRecord(objectRecord(cfg)?.session);
  const store =
    typeof session?.store === "string" && session.store.trim() ? session.store : undefined;
  return listAgentIdsForSessionStoreDetection(cfg).some((agentId) =>
    listMSTeamsFeedbackLearningScanDirs(
      resolveSessionStorePathForStartupDetection(store, agentId),
    ).some((dir) => dirHasFile(dir, (name) => name.endsWith(".learnings.json"))),
  );
}

function listTelegramAccountIdsForStartupDetection(cfg: unknown): string[] {
  const ids = new Set<string>([DEFAULT_ACCOUNT_ID]);
  const root = objectRecord(cfg);
  const channels = objectRecord(root?.channels);
  const telegram = objectRecord(channels?.telegram);
  const accounts = objectRecord(telegram?.accounts);
  for (const id of Object.keys(accounts ?? {})) {
    ids.add(normalizeAccountId(id));
  }
  const bindings = Array.isArray(root?.bindings) ? root.bindings : [];
  for (const binding of bindings) {
    const record = objectRecord(binding);
    const match = objectRecord(record?.match);
    if (typeof match?.channel !== "string" || match.channel.trim().toLowerCase() !== "telegram") {
      continue;
    }
    if (typeof match.accountId === "string" && match.accountId.trim() && match.accountId !== "*") {
      ids.add(normalizeAccountId(match.accountId));
    }
  }
  return [...ids];
}

function hasTelegramSidecarForStorePath(storePath: string): boolean {
  if (
    [
      `${storePath}.telegram-messages.json`,
      `${storePath}.telegram-sent-messages.json`,
      `${storePath}.telegram-topic-names.json`,
    ].some(fileOrDirExists)
  ) {
    return true;
  }
  const basename = path.basename(storePath);
  return dirHasFile(
    path.dirname(storePath),
    (name) => name.startsWith(`${basename}.telegram-message-dispatch-`) && name.endsWith(".json"),
  );
}

function hasTelegramSessionSidecarLegacyState(cfg: unknown): boolean {
  const normalizedCfg = (objectRecord(cfg) ?? {}) as OpenClawConfig;
  const session = objectRecord(objectRecord(cfg)?.session);
  const configuredStore =
    typeof session?.store === "string" && session.store.trim() ? session.store : undefined;
  const storePaths = new Set<string>();
  for (const target of resolveAllAgentSessionStoreTargetsSync(normalizedCfg, {
    env: process.env,
  })) {
    storePaths.add(target.storePath);
  }
  for (const agentId of listAgentIdsForSessionStoreDetection(cfg)) {
    storePaths.add(resolveSessionStorePathForStartupDetection(configuredStore, agentId));
  }
  for (const accountId of listTelegramAccountIdsForStartupDetection(cfg)) {
    storePaths.add(resolveSessionStorePathForStartupDetection(configuredStore, accountId));
  }
  return [...storePaths].some(hasTelegramSidecarForStorePath);
}

function readPluginConfigObject(cfg: unknown, pluginId: string): Record<string, unknown> | null {
  const root = objectRecord(cfg);
  const plugins = objectRecord(root?.plugins);
  const entries = objectRecord(plugins?.entries);
  const entry = objectRecord(entries?.[pluginId]);
  return objectRecord(entry?.config);
}

function resolveConfiguredPath(input: string): string {
  return resolveHomeRelativePath(input, { env: process.env, homedir: os.homedir });
}

function normalizeAgentIdForWorkspace(value: unknown): string {
  return normalizeAgentId(typeof value === "string" ? value : undefined);
}

function listAgentEntriesForWorkspace(cfg: unknown): Record<string, unknown>[] {
  const agents = objectRecord(objectRecord(cfg)?.agents);
  const list = Array.isArray(agents?.list) ? agents.list : [];
  return list.flatMap((entry) => {
    const record = objectRecord(entry);
    return record ? [record] : [];
  });
}

function resolveDefaultAgentIdForWorkspace(cfg: unknown): string {
  const entries = listAgentEntriesForWorkspace(cfg);
  const defaultEntry = entries.find((entry) => entry.default === true) ?? entries[0];
  return normalizeAgentIdForWorkspace(defaultEntry?.id);
}

function resolveDefaultWorkspaceDirForEnv(): string {
  const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR?.trim();
  if (workspaceDir) {
    return path.resolve(workspaceDir);
  }
  const homeDir = resolveRequiredHomeDir(process.env, os.homedir);
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  return profile && profile.toLowerCase() !== "default"
    ? path.join(homeDir, ".openclaw", `workspace-${profile}`)
    : path.join(homeDir, ".openclaw", "workspace");
}

function resolveAgentWorkspaceDirForSnapshot(cfg: unknown, agentId: string): string {
  const id = normalizeAgentIdForWorkspace(agentId);
  const entries = listAgentEntriesForWorkspace(cfg);
  const entry = entries.find((candidate) => normalizeAgentIdForWorkspace(candidate.id) === id);
  if (typeof entry?.workspace === "string" && entry.workspace.trim().length > 0) {
    return resolveConfiguredPath(entry.workspace);
  }
  const defaults = objectRecord(objectRecord(cfg)?.agents)?.defaults;
  const defaultWorkspace = objectRecord(defaults)?.workspace;
  const defaultAgentId = resolveDefaultAgentIdForWorkspace(cfg);
  if (typeof defaultWorkspace === "string" && defaultWorkspace.trim().length > 0) {
    const resolvedDefault = resolveConfiguredPath(defaultWorkspace);
    return id === defaultAgentId ? resolvedDefault : path.join(resolvedDefault, id);
  }
  return id === defaultAgentId
    ? resolveDefaultWorkspaceDirForEnv()
    : path.join(resolveStateDir(process.env, os.homedir), `workspace-${id}`);
}

function listConfiguredAgentWorkspaceDirs(cfg: unknown): string[] {
  const entries = listAgentEntriesForWorkspace(cfg);
  const ids =
    entries.length > 0
      ? [...new Set(entries.map((entry) => normalizeAgentIdForWorkspace(entry.id)))]
      : [resolveDefaultAgentIdForWorkspace(cfg)];
  return [...new Set(ids.map((id) => resolveAgentWorkspaceDirForSnapshot(cfg, id)))];
}

function hasMemoryCoreLegacyWorkspaceState(cfg: unknown): boolean {
  const relativePaths = [
    path.join("memory", ".dreams", "daily-ingestion.json"),
    path.join("memory", ".dreams", "session-ingestion.json"),
    path.join("memory", ".dreams", "short-term-recall.json"),
    path.join("memory", ".dreams", "phase-signals.json"),
  ];
  return listConfiguredAgentWorkspaceDirs(cfg).some((workspaceDir) =>
    relativePaths.some((relativePath) => fileOrDirExists(path.join(workspaceDir, relativePath))),
  );
}

function resolveVoiceCallStorePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    return path.resolve(
      trimmed.replace(/^~(?=$|[\\/])/, resolveRequiredOsHomeDir(process.env, os.homedir)),
    );
  }
  return path.resolve(trimmed);
}

function resolveMemoryWikiVaultPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") {
    return resolveRequiredOsHomeDir(process.env, os.homedir);
  }
  if (trimmed.startsWith("~/")) {
    return path.join(resolveRequiredOsHomeDir(process.env, os.homedir), trimmed.slice(2));
  }
  return trimmed;
}

function hasMemoryWikiLegacyVaultState(cfg: unknown): boolean {
  const config = readPluginConfigObject(cfg, "memory-wiki");
  const vault = objectRecord(config?.vault);
  const rawVaultPath =
    typeof vault?.path === "string" && vault.path.trim().length > 0
      ? vault.path
      : path.join(resolveRequiredOsHomeDir(process.env, os.homedir), ".openclaw", "wiki", "main");
  const vaultRoot = resolveMemoryWikiVaultPath(rawVaultPath);
  return (
    fileOrDirExists(path.join(vaultRoot, ".openclaw-wiki", "source-sync.json")) ||
    dirHasFile(path.join(vaultRoot, ".openclaw-wiki", "import-runs"), (name) =>
      name.endsWith(".json"),
    )
  );
}

function snapshotHasConfiguredPluginLegacyState(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): boolean {
  const cfg = snapshot.runtimeConfig ?? snapshot.config;
  for (const pluginId of ["voice-call", "@openclaw/voice-call"]) {
    const store = readPluginConfigObject(cfg, pluginId)?.store;
    if (typeof store === "string" && store.trim().length > 0) {
      if (fileOrDirExists(path.join(resolveVoiceCallStorePath(store), "calls.jsonl"))) {
        return true;
      }
    }
  }
  return (
    hasMSTeamsFeedbackLearningLegacyState(cfg) ||
    hasTelegramSessionSidecarLegacyState(cfg) ||
    hasMemoryCoreLegacyWorkspaceState(cfg) ||
    hasMemoryWikiLegacyVaultState(cfg)
  );
}

async function snapshotHasPluginDoctorLegacyState(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): Promise<boolean> {
  const cfg = (objectRecord(snapshot.runtimeConfig ?? snapshot.config) ?? {}) as OpenClawConfig;
  const [{ createPluginStateKeyedStore }, { listPluginDoctorStateMigrationEntries }] =
    await Promise.all([
      import("../../plugin-state/plugin-state-store.js"),
      import("../../plugins/doctor-contract-registry.js"),
    ]);
  const stateDir = resolveStateDir(process.env, os.homedir);
  const oauthDir = resolveOAuthDir(process.env, stateDir);
  for (const entry of listPluginDoctorStateMigrationEntries({ config: cfg, env: process.env })) {
    const detected = await entry.migration.detectLegacyState({
      config: cfg,
      env: process.env,
      stateDir,
      oauthDir,
      context: {
        openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
          return createPluginStateKeyedStore<T>(entry.pluginId, {
            ...options,
            env: options.env ?? process.env,
          });
        },
      },
    });
    if (detected?.preview.length) {
      return true;
    }
  }
  return false;
}

async function getConfigSnapshot() {
  // Tests often mutate config fixtures; caching can make those flaky.
  if (process.env.VITEST === "true") {
    return readConfigFileSnapshot();
  }
  if (!configSnapshotPromise) {
    const pendingSnapshot = readConfigFileSnapshot();
    configSnapshotPromise = pendingSnapshot;
    pendingSnapshot.catch(() => {
      if (configSnapshotPromise === pendingSnapshot) {
        configSnapshotPromise = null;
      }
    });
  }
  return configSnapshotPromise;
}

export async function ensureConfigReady(params: {
  runtime: RuntimeEnv;
  commandPath?: string[];
  suppressDoctorStdout?: boolean;
  allowInvalid?: boolean;
  beforeStateMigrations?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
}): Promise<void> {
  const commandPath = params.commandPath ?? [];
  let preflightSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>> | null = null;
  const shouldConsiderStateMigration = shouldMigrateStateFromPath(commandPath);
  const requiresLegacyStateInput = shouldRunStateMigrationOnlyWithLegacyInputs(commandPath);
  const runStateMigrationPreflight = async () => {
    didRunDoctorConfigFlow = true;
    const runDoctorConfigPreflight = async () =>
      (await import("../../commands/doctor-config-preflight.js")).runDoctorConfigPreflight({
        migrateState: true,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        ...(params.beforeStateMigrations
          ? { beforeStateMigrations: params.beforeStateMigrations }
          : {}),
      });
    return !params.suppressDoctorStdout
      ? (await runDoctorConfigPreflight()).snapshot
      : (await withSuppressedNotes(runDoctorConfigPreflight)).snapshot;
  };
  if (
    !didRunDoctorConfigFlow &&
    shouldConsiderStateMigration &&
    (!requiresLegacyStateInput || (await hasLegacyStateMigrationInputs()))
  ) {
    preflightSnapshot = await runStateMigrationPreflight();
  }

  const commandName = commandPath[0];
  const subcommandName = commandPath[1];
  let snapshot = preflightSnapshot ?? (await getConfigSnapshot());
  if (
    !preflightSnapshot &&
    !didRunDoctorConfigFlow &&
    shouldConsiderStateMigration &&
    requiresLegacyStateInput &&
    snapshot.valid &&
    (snapshotHasCanonicalSessionMigrationState(snapshot) ||
      (commandName !== "gateway" && snapshotHasConfiguredSessionStore(snapshot)) ||
      snapshotHasConfiguredCronLegacyState(snapshot) ||
      snapshotHasConfiguredPluginLegacyState(snapshot) ||
      (await snapshotHasPluginDoctorLegacyState(snapshot)))
  ) {
    preflightSnapshot = await runStateMigrationPreflight();
    snapshot = preflightSnapshot;
  }
  const isBareGatewayForegroundRun =
    commandName === "gateway" && (subcommandName === undefined || subcommandName.trim() === "");
  const isReadOnlyTaskStateCommand =
    commandName === "tasks" &&
    (subcommandName === undefined || ALLOWED_INVALID_TASK_SUBCOMMANDS.has(subcommandName));
  const allowInvalid = commandName
    ? params.allowInvalid === true ||
      ALLOWED_INVALID_COMMANDS.has(commandName) ||
      isReadOnlyTaskStateCommand ||
      isBareGatewayForegroundRun ||
      (commandName === "gateway" &&
        subcommandName &&
        ALLOWED_INVALID_GATEWAY_SUBCOMMANDS.has(subcommandName))
    : false;
  const { formatConfigIssueLines } = await import("../../config/issue-format.js");
  const issues =
    snapshot.exists && !snapshot.valid
      ? formatConfigIssueLines(snapshot.issues, "-", { normalizeRoot: true })
      : [];
  const legacyIssues =
    snapshot.legacyIssues.length > 0 ? formatConfigIssueLines(snapshot.legacyIssues, "-") : [];

  const invalid = snapshot.exists && !snapshot.valid;
  if (!invalid) {
    setRuntimeConfigSnapshot(snapshot.runtimeConfig ?? snapshot.config, snapshot.sourceConfig);
  }
  if (!invalid) {
    return;
  }

  const [
    { colorize, isRich, theme },
    { shortenHomePath },
    { formatCliCommand },
    { isPluginPackagingRuntimeOutputInvalidConfigSnapshot },
    { formatPluginPackagingRuntimeOutputRecoveryHint },
  ] = await Promise.all([
    import("../../../packages/terminal-core/src/theme.js"),
    import("../../utils.js"),
    import("../command-format.js"),
    import("../../config/recovery-policy.js"),
    import("../config-recovery-hints.js"),
  ]);
  const rich = isRich();
  const muted = (value: string) => colorize(rich, theme.muted, value);
  const error = (value: string) => colorize(rich, theme.error, value);
  const heading = (value: string) => colorize(rich, theme.heading, value);
  const commandText = (value: string) => colorize(rich, theme.command, value);

  params.runtime.error(heading("OpenClaw config is invalid"));
  params.runtime.error(`${muted("File:")} ${muted(shortenHomePath(snapshot.path))}`);
  if (issues.length > 0) {
    params.runtime.error(muted("Problem:"));
    params.runtime.error(issues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  if (legacyIssues.length > 0) {
    params.runtime.error(muted("Legacy config keys detected:"));
    params.runtime.error(legacyIssues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  params.runtime.error("");
  const fixHint = isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot)
    ? formatPluginPackagingRuntimeOutputRecoveryHint()
    : commandText(formatCliCommand("openclaw doctor --fix"));
  params.runtime.error(`${muted("Fix:")} ${fixHint}`);
  params.runtime.error(
    `${muted("Inspect:")} ${commandText(formatCliCommand("openclaw config validate"))}`,
  );
  params.runtime.error(
    muted(
      "Status, health, logs, tasks list/audit, and doctor commands still run with invalid config.",
    ),
  );
  if (!allowInvalid) {
    params.runtime.exit(1);
  }
}

export const testApi = {
  resetConfigGuardStateForTests,
  hasMSTeamsFeedbackLearningLegacyStateForTests: hasMSTeamsFeedbackLearningLegacyState,
};
export { testApi as __test__ };
