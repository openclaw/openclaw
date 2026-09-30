import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWithinDir } from "@openclaw/fs-safe/path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/paths.js";
import type { SessionEntry } from "../config/sessions.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { resolveAgentsDirFromSessionStorePath } from "../config/sessions/paths.js";
import { resolvePersistedSessionStoreOwner } from "../config/sessions/session-store-owner.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
} from "../config/sessions/targets.js";
import type { SessionScope } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectRelevantDoctorPluginIds,
  isPluginDoctorMigrationDeferred,
  listPluginDoctorSessionStoreAgentIds,
} from "../plugins/doctor-contract-registry.js";
import {
  LEGACY_IMPLICIT_AGENT_ID as DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { readDeferredPluginMigrations } from "./deferred-plugin-migrations.js";
import {
  deferredPluginSessionStoreIds,
  prepareDeferredPluginSessionImportReader,
  preserveDeferredPluginSessionSource,
} from "./deferred-plugin-session-sources.js";
import { readFirstLineSync } from "./first-line-read.js";
import { expandHomePrefix } from "./home-dir.js";
import { importLegacyAcpSessionMetadata } from "./state-migrations.acp-session-metadata.js";
import {
  existsDir,
  migrationFileExists,
  parseSessionStoreJson5,
  readSessionStoreJson5,
  safeReadDir,
  type SessionEntryLike,
} from "./state-migrations.fs.js";
import { saveLegacySessionStore } from "./state-migrations.legacy-session-store.js";
import {
  resolveSessionStoreAliasPlan,
  sessionStorePathsMatch,
} from "./state-migrations.session-store-paths.js";
import {
  isLegacyDefaultMainAliasKey,
  isLegacyGroupKey,
  resolveCanonicalAgentSessionOwner,
  isSurfaceGroupKey,
  type PreparedLegacySessionSurfaces,
} from "./state-migrations.session-surfaces.js";
import type { MigrationMessages, SessionStoreAliasPlan } from "./state-migrations.types.js";

function canonicalizeSessionKeyForAgent(params: {
  key: string;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  skipCrossAgentRemap?: boolean;
  preserveCanonicalAgentOwner?: boolean;
  preserveAmbiguousKeys?: boolean;
  preserveForeignMainAliases?: boolean;
  legacySessionSurfaces?: PreparedLegacySessionSurfaces["surfaces"];
}): string {
  const raw = params.key.trim();
  if (!raw) {
    return raw;
  }
  const rawLower = normalizeLowercaseStringOrEmpty(raw);
  const legacyDefaultMainAlias = isLegacyDefaultMainAliasKey(rawLower, params.mainKey);
  const configuredAgentId = normalizeAgentId(params.agentId);
  const canonicalRowOwner = resolveCanonicalAgentSessionOwner(raw);
  // Shared stores may contain rows for several agents. Canonicalize a valid
  // wrapper within its declared owner so another agent pass cannot adopt it.
  // The default-agent main alias remains an orphan when a different single
  // owner is authoritative for this store.
  const candidateOwner = params.preserveCanonicalAgentOwner ? canonicalRowOwner : undefined;
  const parsedOwner =
    candidateOwner === DEFAULT_AGENT_ID &&
    configuredAgentId !== DEFAULT_AGENT_ID &&
    legacyDefaultMainAlias
      ? undefined
      : candidateOwner;
  const agentId = parsedOwner ?? configuredAgentId;
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(raw);
  if (rawLower === "global" || rawLower === "unknown") {
    return rawLower;
  }
  // Plugin-routed stores can contain either a core orphan or an opaque explicit
  // key with this shape. Without row provenance, never merge the two.
  if (params.preserveForeignMainAliases && legacyDefaultMainAlias) {
    return params.key;
  }
  const canonicalMain = canonicalizeMainSessionAlias({
    cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
    agentId,
    sessionKey: normalized,
  });
  // Global scope has one owner, so recognized main aliases are never ambiguous.
  if (params.scope === "global" && canonicalMain === "global") {
    return canonicalMain;
  }
  // Unscoped and legacy default-main keys in a potentially shared store have no durable owner.
  // Keep it untouched instead of assigning another agent's history by iteration order.
  if (params.preserveAmbiguousKeys && (!canonicalRowOwner || legacyDefaultMainAlias)) {
    return params.key;
  }

  // When shared-store guard is active, do not remap keys that belong to a
  // different agent — they are legitimate records for that agent, not orphans.
  // Without this check, canonicalizeMainSessionAlias (which now recognises
  // legacy agent:main:* aliases) would rewrite them before the
  // skipCrossAgentRemap guard below has a chance to block it.
  if (params.skipCrossAgentRemap) {
    const parsed = parseAgentSessionKey(raw);
    if (parsed && normalizeAgentId(parsed.agentId) !== agentId) {
      return normalized;
    }
    if (
      agentId !== DEFAULT_AGENT_ID &&
      (rawLower === DEFAULT_MAIN_KEY || rawLower === params.mainKey)
    ) {
      return rawLower;
    }
  }

  if (canonicalMain !== normalized) {
    return normalizeLowercaseStringOrEmpty(canonicalMain);
  }

  // Handle cross-agent orphaned main-session keys: "agent:main:main" or
  // "agent:main:<mainKey>" in a store belonging to a different agent (e.g.
  // "ops"). Only remap provable orphan aliases — other agent:main:* keys
  // (hooks, subagents, cron, per-sender) may be intentional cross-agent
  // references and must not be touched (#29683).
  const defaultPrefix = `agent:${DEFAULT_AGENT_ID}:`;
  if (
    rawLower.startsWith(defaultPrefix) &&
    agentId !== DEFAULT_AGENT_ID &&
    !params.skipCrossAgentRemap
  ) {
    const rest = rawLower.slice(defaultPrefix.length);
    const isOrphanAlias = rest === DEFAULT_MAIN_KEY || rest === params.mainKey;
    if (isOrphanAlias) {
      const remapped = `agent:${agentId}:${rest}`;
      const canonicalized = canonicalizeMainSessionAlias({
        cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
        agentId,
        sessionKey: remapped,
      });
      return normalizeLowercaseStringOrEmpty(canonicalized);
    }
  }

  // A malformed agent-shaped key has no authoritative row owner. Once shared-store
  // preservation is ruled out, treat it as opaque input owned by the configured agent.
  if (rawLower.startsWith("agent:") && canonicalRowOwner) {
    return normalized;
  }
  if (rawLower.startsWith("subagent:")) {
    const rest = raw.slice("subagent:".length);
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:subagent:${rest}`);
  }
  // Channel-owned legacy shapes must win before the generic group/channel
  // fallback so plugin-specific legacy group keys can canonicalize to their
  // owning channel instead of the generic `...:unknown:group:...` bucket.
  for (const surface of params.legacySessionSurfaces ?? []) {
    const canonicalized = surface.canonicalizeLegacySessionKey?.({
      key: raw,
      agentId,
    });
    const normalizedCanonicalized = normalizeSessionKeyPreservingOpaquePeerIds(canonicalized);
    if (normalizedCanonicalized) {
      return normalizedCanonicalized;
    }
  }
  if (rawLower.startsWith("group:") || rawLower.startsWith("channel:")) {
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:unknown:${raw}`);
  }
  if (isSurfaceGroupKey(raw)) {
    return `agent:${agentId}:${normalized}`;
  }
  return normalizeSessionKeyPreservingOpaquePeerIds(`agent:${agentId}:${raw}`);
}

export function pickLatestLegacyDirectEntry(
  store: Record<string, SessionEntryLike>,
  legacySessionSurfaces: PreparedLegacySessionSurfaces["surfaces"] = [],
): SessionEntryLike | null {
  let best: SessionEntryLike | null = null;
  let bestUpdated = -1;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const normalized = key.trim();
    if (!normalized) {
      continue;
    }
    const normalizedLower = normalizeLowercaseStringOrEmpty(normalized);
    if (normalizedLower === "global") {
      continue;
    }
    if (normalizedLower.startsWith("agent:")) {
      continue;
    }
    if (normalizedLower.startsWith("subagent:")) {
      continue;
    }
    if (isLegacyGroupKey(normalized, legacySessionSurfaces) || isSurfaceGroupKey(normalized)) {
      continue;
    }
    const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
    if (updatedAt > bestUpdated) {
      bestUpdated = updatedAt;
      best = entry;
    }
  }
  return best;
}

export function normalizeSessionEntry(
  entry: SessionEntryLike,
  sessionKey?: string,
): SessionEntry | null {
  const { room, ...entryWithoutRoom } = entry;
  const shaped = normalizePersistedSessionEntryShape(entryWithoutRoom, { sessionKey });
  if (!shaped) {
    return null;
  }
  const normalized = { ...shaped };
  if (typeof normalized.sessionId === "string") {
    normalized.updatedAt =
      typeof normalized.updatedAt === "number" && Number.isFinite(normalized.updatedAt)
        ? normalized.updatedAt
        : Date.now();
  }
  if (typeof normalized.groupChannel !== "string" && typeof room === "string") {
    normalized.groupChannel = room;
  }
  return normalized;
}

function resolveUpdatedAt(entry: SessionEntryLike): number {
  return typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : 0;
}

export function selectNewerSessionEntry(params: {
  existing: SessionEntryLike | undefined;
  incoming: SessionEntryLike;
  preferIncomingOnTie?: boolean;
}): SessionEntryLike {
  if (!params.existing) {
    return params.incoming;
  }
  const existingUpdated = resolveUpdatedAt(params.existing);
  const incomingUpdated = resolveUpdatedAt(params.incoming);
  if (incomingUpdated > existingUpdated) {
    return params.incoming;
  }
  if (incomingUpdated < existingUpdated) {
    return params.existing;
  }
  return params.preferIncomingOnTie ? params.incoming : params.existing;
}

export function canonicalizeSessionStore(params: {
  store: Record<string, SessionEntryLike>;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  skipCrossAgentRemap?: boolean;
  preserveCanonicalAgentOwner?: boolean;
  preserveAmbiguousKeys?: boolean;
  preserveForeignMainAliases?: boolean;
  legacySessionSurfaces?: PreparedLegacySessionSurfaces["surfaces"];
}): { store: Record<string, SessionEntryLike>; legacyKeys: string[] } {
  const canonical = Object.create(null) as Record<string, SessionEntryLike>;
  const meta = new Map<string, { isCanonical: boolean; updatedAt: number }>();
  const legacyKeys: string[] = [];

  for (const [key, entry] of Object.entries(params.store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const canonicalKey = canonicalizeSessionKeyForAgent({
      key,
      agentId: params.agentId,
      mainKey: params.mainKey,
      scope: params.scope,
      skipCrossAgentRemap: params.skipCrossAgentRemap,
      preserveCanonicalAgentOwner: params.preserveCanonicalAgentOwner,
      preserveAmbiguousKeys: params.preserveAmbiguousKeys,
      preserveForeignMainAliases: params.preserveForeignMainAliases,
      legacySessionSurfaces: params.legacySessionSurfaces,
    });
    const isCanonical = canonicalKey === key;
    if (!isCanonical) {
      legacyKeys.push(key);
    }
    const existingMeta = meta.get(canonicalKey);
    const incomingUpdated = resolveUpdatedAt(entry);
    if (
      !existingMeta ||
      incomingUpdated > existingMeta.updatedAt ||
      (incomingUpdated === existingMeta.updatedAt && isCanonical && !existingMeta.isCanonical)
    ) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: incomingUpdated });
    }
  }

  return { store: canonical, legacyKeys };
}

export function isAmbiguousSharedStoreKey(
  key: string,
  mainKey: string,
  scope?: SessionScope,
): boolean {
  const raw = key.trim();
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if (!raw || lower === "global" || lower === "unknown") {
    return false;
  }
  if (
    scope === "global" &&
    canonicalizeMainSessionAlias({
      cfg: { session: { scope, mainKey } },
      agentId: DEFAULT_AGENT_ID,
      sessionKey: lower,
    }) === "global"
  ) {
    return false;
  }
  return !resolveCanonicalAgentSessionOwner(raw) || isLegacyDefaultMainAliasKey(lower, mainKey);
}

export function aliasedSessionStoreMigrationWarning(params: {
  subject: "migration of" | "ACP metadata migration for";
  count: number;
  storePath: string;
}): string {
  return `Deferred ${params.subject} ${params.count} ambiguous session key(s) in aliased store ${params.storePath}; remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`;
}

export function unresolvedSessionStoreIdentityWarning(subject: string, storePath: string): string {
  return `Deferred ${subject} for ${storePath}; filesystem identity could not be established for every configured store path. Restore path access or configure one canonical session.store path, then rerun openclaw doctor --fix`;
}

export function distinctSessionStoreAliasWarning(subject: string, storePath: string): string {
  return `Deferred ${subject} in aliased store ${storePath}; atomic replacement cannot update distinct filesystem aliases as one operation. Remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`;
}

export function resolveStaleLegacySessionFile(params: {
  entry: unknown;
  legacyDir: string;
  targetDir: string;
}): string | undefined {
  if (!params.entry || typeof params.entry !== "object" || Array.isArray(params.entry)) {
    return undefined;
  }
  const entry = params.entry as SessionEntryLike;
  const rawSessionFile = entry.sessionFile;
  if (typeof rawSessionFile !== "string") {
    return undefined;
  }
  const legacySessionFile = path.isAbsolute(rawSessionFile)
    ? path.resolve(rawSessionFile)
    : path.resolve(params.legacyDir, rawSessionFile);
  const relative = path.relative(path.resolve(params.legacyDir), legacySessionFile);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    migrationFileExists(legacySessionFile)
  ) {
    return undefined;
  }
  const legacyBackupHasTranscript = safeReadDir(path.dirname(params.legacyDir)).some(
    (dirent) =>
      dirent.isDirectory() &&
      dirent.name.startsWith(`${path.basename(params.legacyDir)}.legacy-`) &&
      migrationFileExists(
        path.join(path.dirname(params.legacyDir), dirent.name, path.basename(legacySessionFile)),
      ),
  );
  if (legacyBackupHasTranscript) {
    return undefined;
  }
  const parsed = path.parse(path.basename(legacySessionFile));
  const hasCollisionRename = safeReadDir(params.targetDir).some(
    (dirent) =>
      dirent.isFile() &&
      dirent.name.startsWith(`${parsed.name}.legacy-`) &&
      dirent.name.endsWith(parsed.ext),
  );
  if (hasCollisionRename) {
    return undefined;
  }
  const targetSessionFile = path.join(params.targetDir, path.basename(legacySessionFile));
  if (!migrationFileExists(targetSessionFile) || typeof entry.sessionId !== "string") {
    return undefined;
  }
  try {
    const firstLine = readFirstLineSync(targetSessionFile);
    const header = firstLine ? (JSON.parse(firstLine) as unknown) : undefined;
    if (!header || typeof header !== "object" || Array.isArray(header)) {
      return undefined;
    }
    if ((header as { type?: unknown }).type === "session") {
      return (header as { id?: unknown }).id === entry.sessionId ? targetSessionFile : undefined;
    }
    const canonicalFileName =
      path.basename(entry.sessionId) === entry.sessionId ? `${entry.sessionId}.jsonl` : undefined;
    return canonicalFileName === path.basename(targetSessionFile) ? targetSessionFile : undefined;
  } catch {
    return undefined;
  }
}

function sessionStoreMayNeedCanonicalization(params: {
  store: Record<string, SessionEntryLike>;
  storeAgentIds: Iterable<string>;
  mainKey: string;
  scope?: SessionScope;
  preserveForeignMainAliases?: boolean;
}): boolean {
  const storeAgentIds = new Set([...params.storeAgentIds].map((id) => normalizeAgentId(id)));
  const hasNonMainAgent = [...storeAgentIds].some((id) => id !== DEFAULT_AGENT_ID);
  for (const key of Object.keys(params.store)) {
    const rawKey = key.trim();
    if (rawKey !== key) {
      return true;
    }
    if (!rawKey) {
      continue;
    }
    const lowerKey = normalizeLowercaseStringOrEmpty(rawKey);
    if (lowerKey !== rawKey) {
      return true;
    }
    if (lowerKey === "global" || lowerKey === "unknown") {
      continue;
    }
    if (
      params.preserveForeignMainAliases &&
      isLegacyDefaultMainAliasKey(lowerKey, params.mainKey)
    ) {
      return true;
    }
    if (lowerKey === DEFAULT_MAIN_KEY || lowerKey === params.mainKey) {
      return true;
    }
    if (lowerKey.startsWith("subagent:")) {
      return true;
    }
    if (lowerKey.startsWith("group:") || lowerKey.startsWith("channel:")) {
      return true;
    }
    if (!lowerKey.startsWith("agent:")) {
      return true;
    }
    const rowOwner = resolveCanonicalAgentSessionOwner(rawKey);
    if (!rowOwner) {
      return true;
    }
    const agentMainAlias = `agent:${rowOwner}:${DEFAULT_MAIN_KEY}`;
    const agentMainKey = `agent:${rowOwner}:${params.mainKey}`;
    if (
      lowerKey === agentMainAlias &&
      (params.mainKey !== DEFAULT_MAIN_KEY || params.scope === "global")
    ) {
      return true;
    }
    if (lowerKey === agentMainKey && params.scope === "global") {
      return true;
    }
    if (
      lowerKey === `agent:${DEFAULT_AGENT_ID}:${DEFAULT_MAIN_KEY}` &&
      (params.mainKey !== DEFAULT_MAIN_KEY || hasNonMainAgent || params.scope === "global")
    ) {
      return true;
    }
    if (
      lowerKey === `agent:${DEFAULT_AGENT_ID}:${params.mainKey}` &&
      hasNonMainAgent &&
      !storeAgentIds.has(DEFAULT_AGENT_ID)
    ) {
      return true;
    }
  }
  return false;
}

export function listLegacySessionKeys(params: {
  store: Record<string, SessionEntryLike>;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  preserveAmbiguousKeys?: boolean;
  preserveForeignMainAliases?: boolean;
  legacySessionSurfaces?: PreparedLegacySessionSurfaces["surfaces"];
}): string[] {
  const legacy: string[] = [];
  for (const key of Object.keys(params.store)) {
    const canonical = canonicalizeSessionKeyForAgent({
      key,
      agentId: params.agentId,
      mainKey: params.mainKey,
      scope: params.scope,
      skipCrossAgentRemap: params.preserveAmbiguousKeys,
      preserveCanonicalAgentOwner: params.preserveAmbiguousKeys,
      preserveAmbiguousKeys: params.preserveAmbiguousKeys,
      preserveForeignMainAliases: params.preserveForeignMainAliases,
      legacySessionSurfaces: params.legacySessionSurfaces,
    });
    if (canonical !== key) {
      legacy.push(key);
    }
  }
  return legacy;
}

export function removeDirIfEmpty(dir: string) {
  if (!existsDir(dir) || safeReadDir(dir).length > 0) {
    return;
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // ignore
  }
}

export async function migrateOrphanedSessionKeys(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  additionalAgentIds?: readonly string[];
  legacySessionSurfaces: PreparedLegacySessionSurfaces | (() => PreparedLegacySessionSurfaces);
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const recoverableWarnings: string[] = [];
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  let preparedLegacySessionSurfaces: PreparedLegacySessionSurfaces | undefined;
  const resolveLegacySessionSurfaces = () =>
    (preparedLegacySessionSurfaces ??=
      typeof params.legacySessionSurfaces === "function"
        ? params.legacySessionSurfaces()
        : params.legacySessionSurfaces);
  const stateDir = resolveStateDir(env);
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const scope = params.cfg.session?.scope as SessionScope | undefined;
  const storeConfig = params.cfg.session?.store;
  const persistedStoreOwner = resolvePersistedSessionStoreOwner(params.cfg);
  const pendingPluginMigrations = await withArtifactPreservingStateReads(() =>
    withOpenClawStateDatabaseReadSnapshot(async () => readDeferredPluginMigrations({ env }), {
      env,
    }),
  );
  const persistedStoreAgentId =
    persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined;
  const persistedStorePath =
    persistedStoreAgentId && storeConfig
      ? resolveStorePathFromTemplate(storeConfig, persistedStoreAgentId, env)
      : undefined;
  const pluginAgentIds =
    params.additionalAgentIds ??
    listPluginDoctorSessionStoreAgentIds({
      config: params.cfg,
      env,
      pluginIds: collectRelevantDoctorPluginIds(params.cfg),
    });
  const pluginAgentIdSet = new Set(pluginAgentIds.map((id) => normalizeAgentId(id)));

  // Fixed session.store paths can be shared by several agent owners.
  const storeMap = new Map<string, Set<string>>();
  const storeAliasCandidates = new Map<string, Set<string>>();
  const addToStoreMap = (p: string, id: string) => {
    try {
      // Exact SQLite locators are canonical databases, never legacy JSON sources.
      if (p.endsWith(".sqlite") || !fs.statSync(p, { throwIfNoEntry: false })?.isFile()) {
        return;
      }
    } catch {
      // Inaccessible paths must stay in their fail-closed alias group.
    }
    // A fixed-store owner is durable migration provenance. Keep other configured
    // agents from making that store's unscoped rows look ambiguous.
    const ownerId =
      persistedStoreAgentId && persistedStorePath && sessionStorePathsMatch(p, persistedStorePath)
        ? persistedStoreAgentId
        : id;
    // Existing aliases are one ownership surface. Group them before any atomic
    // rewrite can replace one pathname and hide their original identity.
    const storePath =
      [...storeMap.keys()].find((candidate) => sessionStorePathsMatch(candidate, p)) ?? p;
    const aliasCandidates = storeAliasCandidates.get(storePath) ?? new Set([storePath]);
    aliasCandidates.add(p);
    storeAliasCandidates.set(storePath, aliasCandidates);
    storeMap.set(storePath, (storeMap.get(storePath) ?? new Set<string>()).add(ownerId));
  };
  // Plugin-owned agents can be absent from config; retain configured-owner order.
  for (const agentId of [...listConfiguredSessionStoreAgentIds(params.cfg), ...pluginAgentIds]) {
    const id = normalizeAgentId(agentId);
    const p = storeConfig
      ? resolveStorePathFromTemplate(storeConfig, id, env)
      : path.join(stateDir, "agents", id, "sessions", "sessions.json");
    addToStoreMap(p, id);
  }
  // Agent directories present on disk.
  // This only covers the standard state-dir layout so we can still pick up
  // orphaned stores left behind by older configs. Active custom-template paths
  // are already covered by the configured-agents loop above.
  const agentsDir = path.join(stateDir, "agents");
  if (existsDir(agentsDir)) {
    for (const dirEntry of safeReadDir(agentsDir)) {
      if (dirEntry.isDirectory()) {
        const diskAgentId = normalizeAgentId(dirEntry.name);
        if (diskAgentId) {
          const diskPath = path.join(agentsDir, diskAgentId, "sessions", "sessions.json");
          addToStoreMap(diskPath, diskAgentId);
        }
      }
    }
  }

  for (const [mappedStorePath, storeAgentIds] of storeMap) {
    if (
      [...storeAgentIds].some((agentId) =>
        preserveDeferredPluginSessionSource({
          cfg: params.cfg,
          env,
          target: { agentId, storePath: mappedStorePath },
          pending: pendingPluginMigrations,
        }),
      )
    ) {
      continue;
    }
    const storePaths = storeAliasCandidates.get(mappedStorePath) ?? new Set([mappedStorePath]);
    // An unknown relationship may have grouped a readable store behind an
    // inaccessible pathname. Read from a usable alias so the group still gets
    // the unresolved-identity warning before any rewrite is attempted.
    const storePath = [...storePaths].find((candidate) => migrationFileExists(candidate));
    if (!storePath) {
      continue;
    }
    const pluginForeignMainAliasRisk = [...storeAgentIds].some(
      (id) => pluginAgentIdSet.has(id) && id !== DEFAULT_AGENT_ID,
    );
    let parsed: ReturnType<typeof parseSessionStoreJson5>;
    try {
      parsed = parseSessionStoreJson5(fs.readFileSync(storePath, "utf-8"));
    } catch (err) {
      warnings.push(`Could not read ${storePath}: ${String(err)}`);
      continue;
    }
    if (
      !parsed.ok ||
      !sessionStoreMayNeedCanonicalization({
        store: parsed.store,
        storeAgentIds,
        mainKey,
        scope,
        preserveForeignMainAliases: pluginForeignMainAliasRisk,
      })
    ) {
      continue;
    }
    const legacySessionSurfaces = resolveLegacySessionSurfaces();
    if (legacySessionSurfaces.failures.length > 0) {
      return {
        changes,
        warnings: [...warnings, ...recoverableWarnings, ...legacySessionSurfaces.failures],
      };
    }
    // A physical store can have several owners. Canonicalize valid scoped rows
    // within their declared owner on every pass so iteration order cannot move
    // one agent's history into another namespace.
    let working = parsed.store;
    let totalLegacy = 0;
    const storeAliases = resolveSessionStoreAliasPlan(storePath, storePaths);
    const hasDistinctAliases = storeAliases.hasDistinctAliases;
    const preserveAmbiguousKeys = storeAgentIds.size > 1;
    const preservedAmbiguousKeyCount = Object.keys(working).filter(
      (key) =>
        (preserveAmbiguousKeys && isAmbiguousSharedStoreKey(key, mainKey, scope)) ||
        (pluginForeignMainAliasRisk && isLegacyDefaultMainAliasKey(key, mainKey)),
    ).length;
    if (storeAliases.hasUnresolvedIdentity) {
      warnings.push(unresolvedSessionStoreIdentityWarning("session key migration", storePath));
      continue;
    }
    if (hasDistinctAliases && preservedAmbiguousKeyCount > 0) {
      warnings.push(
        aliasedSessionStoreMigrationWarning({
          subject: "migration of",
          count: preservedAmbiguousKeyCount,
          storePath,
        }),
      );
      continue;
    }
    if (storeAliases.hasFinalSymlink) {
      warnings.push(
        `Deferred session key migration in final-component symlink store ${storePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
      );
      continue;
    }
    if (hasDistinctAliases) {
      warnings.push(distinctSessionStoreAliasWarning("session key migration", storePath));
      continue;
    }
    for (const storeAgentId of storeAgentIds) {
      const { store: canonicalized, legacyKeys } = canonicalizeSessionStore({
        store: working,
        agentId: storeAgentId,
        mainKey,
        scope,
        skipCrossAgentRemap: preserveAmbiguousKeys,
        preserveCanonicalAgentOwner: true,
        preserveAmbiguousKeys,
        preserveForeignMainAliases: pluginForeignMainAliasRisk,
        legacySessionSurfaces: legacySessionSurfaces.surfaces,
      });
      working = canonicalized;
      // Each pass only counts keys it changed from the current working store, so
      // once a key is canonicalized it is not counted again by later agent passes.
      totalLegacy += legacyKeys.length;
    }
    if (preservedAmbiguousKeyCount > 0) {
      recoverableWarnings.push(
        `Preserved ${preservedAmbiguousKeyCount} ambiguous session key(s) in potentially shared store ${storePath}`,
      );
    }
    if (totalLegacy === 0) {
      continue;
    }
    const normalized = Object.create(null) as Record<string, SessionEntry>;
    for (const [key, entry] of Object.entries(working)) {
      const ne = normalizeSessionEntry(entry, key);
      if (ne) {
        normalized[key] = ne;
      }
    }
    try {
      await saveSessionStoreStrict(storePath, normalized);
      changes.push(`Canonicalized ${totalLegacy} orphaned session key(s) in ${storePath}`);
    } catch (err) {
      warnings.push(`Failed to write canonicalized store ${storePath}: ${String(err)}`);
    }
  }

  return {
    changes,
    warnings: [...warnings, ...recoverableWarnings],
    ...(warnings.length === 0 && recoverableWarnings.length > 0
      ? { warningDisposition: "recoverable" as const }
      : {}),
  };
}

export async function migrateLegacyAcpSessionMetadata(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  pluginSessionStoreAgentIds?: readonly string[];
  legacySessionSurfaces: PreparedLegacySessionSurfaces;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  if (params.legacySessionSurfaces.failures.length > 0) {
    return {
      changes,
      warnings: [...params.legacySessionSurfaces.failures],
    };
  }
  const now = params.now ?? (() => Date.now());
  const pending = await withArtifactPreservingStateReads(() =>
    withOpenClawStateDatabaseReadSnapshot(async () => readDeferredPluginMigrations({ env }), {
      env,
    }),
  );
  const stateDir = resolveStateDir(env);
  const storeConfig = params.cfg.session?.store;
  const pluginAgentIds =
    params.pluginSessionStoreAgentIds ??
    listPluginDoctorSessionStoreAgentIds({
      config: params.cfg,
      env,
      pluginIds: collectRelevantDoctorPluginIds(params.cfg),
    });
  const normalizedPluginAgentIds = new Set(pluginAgentIds.map((id) => normalizeAgentId(id)));
  const declaredAgentIds = new Set([
    ...listConfiguredSessionStoreAgentIds(params.cfg).map((id) => normalizeAgentId(id)),
    ...normalizedPluginAgentIds,
  ]);
  const declaredTargets = [...declaredAgentIds].map((agentId) => ({
    agentId,
    storePath: storeConfig
      ? resolveStorePathFromTemplate(storeConfig, agentId, env)
      : path.join(stateDir, "agents", agentId, "sessions", "sessions.json"),
  }));
  const pluginTargets = declaredTargets.filter(
    ({ agentId }) => agentId !== DEFAULT_AGENT_ID && normalizedPluginAgentIds.has(agentId),
  );
  const configuredAgents = listAgentEntries(params.cfg);
  const configuredAgentIds = new Set(
    configuredAgents.flatMap((entry) => (entry?.id ? [normalizeAgentId(entry.id)] : [])),
  );
  const discoveryCfg = [...declaredAgentIds].some((agentId) => !configuredAgentIds.has(agentId))
    ? ({
        ...params.cfg,
        agents: {
          ...params.cfg.agents,
          list: [
            ...configuredAgents,
            ...[...declaredAgentIds]
              .filter((agentId) => !configuredAgentIds.has(agentId))
              .map((id) => ({ id })),
          ],
        },
      } as OpenClawConfig)
    : params.cfg;
  // Reuse the validated resolver for every declared owner. Owner multiplicity
  // is restored below as metadata without re-adding rejected raw paths.
  const targets = resolveLegacyAcpMetadataSessionStoreTargets(discoveryCfg, env);
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const scope = params.cfg.session?.scope as SessionScope | undefined;
  const storeGroups: Array<{
    target: (typeof targets)[number];
    agentIds: Set<string>;
    aliasCandidates: Set<string>;
  }> = [];

  for (const target of targets) {
    if (!migrationFileExists(target.storePath)) {
      continue;
    }
    const group = storeGroups.find(({ target: existing }) =>
      sessionStorePathsMatch(existing.storePath, target.storePath),
    );
    const matchingDeclaredTargets = declaredTargets.filter((declaredTarget) =>
      sessionStorePathsMatch(target.storePath, declaredTarget.storePath),
    );
    if (group) {
      group.agentIds.add(normalizeAgentId(target.agentId));
      group.aliasCandidates.add(target.storePath);
      for (const declaredTarget of matchingDeclaredTargets) {
        group.agentIds.add(declaredTarget.agentId);
        group.aliasCandidates.add(declaredTarget.storePath);
      }
      continue;
    }
    storeGroups.push({
      target,
      agentIds: new Set([
        normalizeAgentId(target.agentId),
        ...matchingDeclaredTargets.map((declaredTarget) => declaredTarget.agentId),
      ]),
      aliasCandidates: new Set([
        target.storePath,
        ...matchingDeclaredTargets.map((declaredTarget) => declaredTarget.storePath),
      ]),
    });
  }

  for (const { target, agentIds, aliasCandidates } of storeGroups) {
    const storePath = target.storePath;
    if (deferredPluginSessionStoreIds({ target, pending }).some(isPluginDoctorMigrationDeferred)) {
      continue;
    }
    const preserveSource = preserveDeferredPluginSessionSource({
      cfg: params.cfg,
      env,
      target,
      pending,
    });
    const storeAliases = resolveSessionStoreAliasPlan(storePath, aliasCandidates);
    const pluginForeignMainAliasRisk = pluginTargets.some((pluginTarget) =>
      sessionStorePathsMatch(storePath, pluginTarget.storePath),
    );
    let parsed: ReturnType<typeof readSessionStoreJson5>;
    try {
      parsed = readSessionStoreJson5(storePath);
    } catch (err) {
      warnings.push(`Could not read ${storePath}: ${String(err)}`);
      continue;
    }
    if (!parsed.ok) {
      continue;
    }
    const ambiguousKeyCount = Object.keys(parsed.store).filter(
      (key) =>
        isAmbiguousSharedStoreKey(key, mainKey, scope) ||
        (pluginForeignMainAliasRisk && isLegacyDefaultMainAliasKey(key, mainKey)),
    ).length;
    const hasLegacyAcpMetadata = Object.entries(parsed.store).some(
      ([sessionKey, entry]) => normalizeSessionEntry(entry, sessionKey)?.acp !== undefined,
    );
    if (hasLegacyAcpMetadata && storeAliases.hasUnresolvedIdentity) {
      warnings.push(unresolvedSessionStoreIdentityWarning("ACP metadata migration", storePath));
      continue;
    }
    if (hasLegacyAcpMetadata && storeAliases.hasFinalSymlink) {
      warnings.push(
        `Deferred ACP metadata migration in final-component symlink store ${storePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
      );
      continue;
    }
    if (hasLegacyAcpMetadata && storeAliases.hasDistinctAliases) {
      // Removing ACP metadata rewrites the store and would split its aliases.
      warnings.push(
        ambiguousKeyCount > 0
          ? aliasedSessionStoreMigrationWarning({
              subject: "ACP metadata migration for",
              count: ambiguousKeyCount,
              storePath,
            })
          : distinctSessionStoreAliasWarning("ACP metadata migration", storePath),
      );
      continue;
    }

    const readVerifiedCoreImport = prepareDeferredPluginSessionImportReader({
      cfg: params.cfg,
      target,
      env,
    });
    const normalized = Object.create(null) as Record<string, SessionEntry>;
    let migrated = 0;
    let consumed = 0;
    let preserved = 0;
    for (const [sessionKey, entry] of Object.entries(parsed.store)) {
      const normalizedEntry = normalizeSessionEntry(entry, sessionKey);
      if (!normalizedEntry) {
        continue;
      }
      if (normalizedEntry.acp) {
        const ambiguousSharedStoreKey = isAmbiguousSharedStoreKey(sessionKey, mainKey, scope);
        const ambiguousMultiOwnerKey = agentIds.size > 1 && ambiguousSharedStoreKey;
        const foreignMainAlias =
          pluginForeignMainAliasRisk && isLegacyDefaultMainAliasKey(sessionKey, mainKey);
        if (ambiguousMultiOwnerKey || foreignMainAlias) {
          preserved++;
          normalized[sessionKey] = normalizedEntry;
          continue;
        }
        const rowAgentId = resolveCanonicalAgentSessionOwner(sessionKey) ?? target.agentId;
        const canonicalSessionKey = canonicalizeSessionKeyForAgent({
          key: sessionKey,
          agentId: rowAgentId,
          mainKey,
          scope,
          skipCrossAgentRemap: true,
          legacySessionSurfaces: params.legacySessionSurfaces.surfaces,
        });
        const imported = importLegacyAcpSessionMetadata({
          sourcePath: storePath,
          sourceSessionKey: sessionKey,
          preserveSource,
          cfg: params.cfg,
          agentId: rowAgentId,
          readVerifiedCoreImport,
          sessionKey: canonicalSessionKey,
          sessionId: normalizedEntry.sessionId,
          lifecycleRevision: normalizedEntry.lifecycleRevision,
          meta: normalizedEntry.acp,
          env,
          now,
        });
        delete normalizedEntry.acp;
        consumed++;
        if (imported) {
          migrated++;
        }
      }
      normalized[sessionKey] = normalizedEntry;
    }
    if (preserved > 0) {
      warnings.push(
        `Preserved ACP metadata for ${preserved} ambiguous session key(s) in potentially shared store ${storePath}`,
      );
    }
    if (consumed === 0 || (preserveSource && migrated === 0)) {
      continue;
    }
    try {
      if (!preserveSource) {
        await saveSessionStoreStrict(storePath, normalized);
      }
      changes.push(
        migrated > 0
          ? `Migrated ${migrated} ACP session metadata ${migrated === 1 ? "row" : "rows"} → shared SQLite state`
          : `Removed previously imported ACP metadata from ${storePath}`,
      );
    } catch (err) {
      warnings.push(`Failed to write ACP metadata migration source ${storePath}: ${String(err)}`);
    }
  }

  return { changes, warnings };
}

// Doctor migration must read legacy session stores even before a per-agent
// SQLite DB exists; active runtime discovery remains SQLite-validated.
function resolveLegacyAcpMetadataSessionStoreTargets(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Array<{ agentId: string; storePath: string }> {
  const stateDir = resolveStateDir(env);
  const agentsDirs = new Set<string>([path.join(stateDir, "agents")]);
  const targets = new Map<string, { agentId: string; storePath: string }>();
  const addTarget = (agentId: string, storePath: string) => {
    if (storePath.endsWith(".sqlite") || !isManagedLegacySessionStorePathSafe(storePath)) {
      return;
    }
    const agentsDir = resolveAgentsDirFromSessionStorePath(storePath);
    if (agentsDir) {
      agentsDirs.add(agentsDir);
    }
    if (!targets.has(storePath)) {
      targets.set(storePath, { agentId, storePath });
    }
  };

  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) {
    addTarget(target.agentId, target.storePath);
  }
  for (const target of resolveSessionStoreTargets(cfg, { allAgents: true }, { env })) {
    addTarget(target.agentId, target.storePath);
  }

  for (const agentsDir of agentsDirs) {
    if (!existsDir(agentsDir)) {
      continue;
    }
    for (const entry of safeReadDir(agentsDir)) {
      if (!entry.isDirectory()) {
        continue;
      }
      const agentId = normalizeAgentId(entry.name);
      const normalizedDirName = normalizeLowercaseStringOrEmpty(entry.name);
      if (agentId === DEFAULT_AGENT_ID && normalizedDirName !== agentId) {
        continue;
      }
      addTarget(agentId, path.join(agentsDir, entry.name, "sessions", "sessions.json"));
    }
  }
  return [...targets.values()];
}

function isManagedLegacySessionStorePathSafe(storePath: string): boolean {
  const resolvedStorePath = path.resolve(storePath);
  const agentsDir = resolveAgentsDirFromSessionStorePath(resolvedStorePath);
  if (!agentsDir) {
    return true;
  }
  if (!migrationFileExists(resolvedStorePath)) {
    return true;
  }

  try {
    const stat = fs.lstatSync(resolvedStorePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return false;
    }
    const resolvedAgentsDir = path.resolve(agentsDir);
    const realStorePath = fs.realpathSync.native(resolvedStorePath);
    const realAgentsDir = fs.realpathSync.native(resolvedAgentsDir);
    return isWithinDir(realAgentsDir, realStorePath);
  } catch {
    return false;
  }
}

function resolveStorePathFromTemplate(
  template: string,
  agentId: string,
  env?: NodeJS.ProcessEnv,
): string {
  const expand = (s: string) =>
    s.startsWith("~") ? expandHomePrefix(s, { env: env ?? process.env, homedir: os.homedir }) : s;
  return path.resolve(expand(template.replaceAll("{agentId}", agentId)));
}

export function mergeSessionStoreAliasPlans(
  left: SessionStoreAliasPlan | undefined,
  right: SessionStoreAliasPlan,
): SessionStoreAliasPlan {
  if (!left) {
    return right;
  }
  return {
    hasDistinctAliases: left.hasDistinctAliases || right.hasDistinctAliases,
    hasFinalSymlink: left.hasFinalSymlink || right.hasFinalSymlink,
    hasUnresolvedIdentity: left.hasUnresolvedIdentity || right.hasUnresolvedIdentity,
  };
}

export async function saveSessionStoreStrict(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  await saveLegacySessionStore(storePath, store, {
    requireWriteSuccess: true,
    skipMaintenance: true,
  });
}

export type SessionStoreOwnership = {
  preserveAmbiguousKeys: boolean;
  preserveForeignMainAliases: boolean;
  targetStoreAliases: SessionStoreAliasPlan;
};

export function resolveSessionStoreOwnership(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  targetAgentId: string;
  pluginSessionStoreAgentIds: readonly string[];
}): SessionStoreOwnership {
  const targetStorePath = path.join(
    params.stateDir,
    "agents",
    params.targetAgentId,
    "sessions",
    "sessions.json",
  );
  const configuredStore = params.cfg.session?.store;
  const resolveAgentStorePath = (agentId: string) =>
    configuredStore
      ? resolveStorePathFromTemplate(configuredStore, agentId, params.env)
      : path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
  const preserveForeignMainAliases = params.pluginSessionStoreAgentIds.some((pluginAgentId) => {
    const id = normalizeAgentId(pluginAgentId);
    if (id === DEFAULT_AGENT_ID) {
      return false;
    }
    return sessionStorePathsMatch(resolveAgentStorePath(id), targetStorePath);
  });
  const candidateAgentIds = new Set([
    ...listConfiguredSessionStoreAgentIds(params.cfg).map((id) => normalizeAgentId(id)),
    ...params.pluginSessionStoreAgentIds.map((id) => normalizeAgentId(id)),
  ]);
  const configuredOwnerStorePaths = [...candidateAgentIds].map(resolveAgentStorePath);
  const targetStoreOwnerCount = configuredOwnerStorePaths.filter((storePath) =>
    sessionStorePathsMatch(storePath, targetStorePath),
  ).length;
  const preserveAmbiguousKeys = targetStoreOwnerCount > 1;
  const candidateStorePaths = [...configuredOwnerStorePaths];
  const agentsDir = path.join(params.stateDir, "agents");
  for (const entry of safeReadDir(agentsDir)) {
    if (entry.isDirectory()) {
      candidateStorePaths.push(path.join(agentsDir, entry.name, "sessions", "sessions.json"));
    }
  }
  const targetStoreAliases = resolveSessionStoreAliasPlan(targetStorePath, candidateStorePaths);
  return { preserveAmbiguousKeys, preserveForeignMainAliases, targetStoreAliases };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
