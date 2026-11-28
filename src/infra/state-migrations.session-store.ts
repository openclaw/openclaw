import fs from "node:fs";
import path from "node:path";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizePersistedSessionEntryShape } from "../commands/doctor/shared/session-entry-shape.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/paths.js";
import type { SessionEntry } from "../config/sessions.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { resolvePersistedSessionStoreOwner } from "../config/sessions/session-store-owner.js";
import { assertSupportedSessionStoreEntry } from "../config/sessions/supported-session-store.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets.js";
import type { SessionScope } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { preparePluginDoctorSessionStoreAgentIds } from "../plugins/doctor-contract-preparation.js";
import { collectRelevantDoctorPluginIds } from "../plugins/doctor-contract-registry.js";
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
import { preserveDeferredPluginSessionSource } from "./deferred-plugin-session-sources.js";
import { expandHomePrefix } from "./home-dir.js";
import { readDirectoryEntriesSync } from "./path-existence.js";
import { safeStatSync } from "./path-guards.js";
import { parseSessionStoreJson5, type SessionEntryLike } from "./state-migrations.fs.js";
import { saveLegacySessionStore } from "./state-migrations.legacy-session-store.js";
import {
  resolveSessionStoreAliasPlan,
  sessionStorePathsMatch,
} from "./state-migrations.session-store-paths.js";
import {
  isAmbiguousSharedStoreKey,
  isLegacyDefaultMainAliasKey,
  resolveCanonicalAgentSessionOwner,
  type PreparedLegacySessionSurfaces,
} from "./state-migrations.session-surfaces.js";
import type { MigrationMessages, SessionStoreAliasPlan } from "./state-migrations.types.js";
import { decodeUtf8Input, Utf8InputError } from "./utf8-input.js";

type SessionKeyCanonicalizationOptions = {
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  preserveAmbiguousKeys?: boolean;
  preserveForeignMainAliases?: boolean;
  legacySessionSurfaces?: PreparedLegacySessionSurfaces["surfaces"];
};

export function canonicalizeSessionKeyForAgent(
  params: SessionKeyCanonicalizationOptions & {
    key: string;
    skipCrossAgentRemap?: boolean;
    preserveCanonicalAgentOwner?: boolean;
  },
): string {
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
  if (raw.includes(":group:") || raw.includes(":channel:")) {
    return `agent:${agentId}:${normalized}`;
  }
  return normalizeSessionKeyPreservingOpaquePeerIds(`agent:${agentId}:${raw}`);
}

export function normalizeSessionEntry(
  entry: SessionEntryLike,
  sessionKey?: string,
): SessionEntry | null {
  assertSupportedSessionStoreEntry(entry);
  const shaped = normalizePersistedSessionEntryShape(entry, { sessionKey });
  if (!shaped) {
    return null;
  }
  const normalized = { ...shaped };
  if (typeof normalized.sessionId === "string") {
    normalized.updatedAt = asFiniteNumber(normalized.updatedAt) ?? Date.now();
  }
  return normalized;
}

export function canonicalizeSessionStore({
  store,
  ...options
}: SessionKeyCanonicalizationOptions & {
  store: Record<string, SessionEntryLike>;
}): { store: Record<string, SessionEntryLike>; legacyKeys: string[] } {
  const canonical = Object.create(null) as Record<string, SessionEntryLike>;
  const meta = new Map<string, { isCanonical: boolean; updatedAt: number }>();
  const legacyKeys: string[] = [];

  for (const [key, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const canonicalKey = canonicalizeSessionKeyForAgent({
      ...options,
      key,
      skipCrossAgentRemap: options.preserveAmbiguousKeys,
      preserveCanonicalAgentOwner: true,
    });
    const isCanonical = canonicalKey === key;
    if (!isCanonical) {
      legacyKeys.push(key);
    }
    const existingMeta = meta.get(canonicalKey);
    const incomingUpdated = asFiniteNumber(entry.updatedAt) ?? 0;
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

export function listLegacySessionKeys({
  store,
  ...options
}: SessionKeyCanonicalizationOptions & {
  store: Record<string, SessionEntryLike>;
}): string[] {
  return Object.keys(store).filter(
    (key) =>
      canonicalizeSessionKeyForAgent({
        ...options,
        key,
        skipCrossAgentRemap: options.preserveAmbiguousKeys,
        preserveCanonicalAgentOwner: options.preserveAmbiguousKeys,
      }) !== key,
  );
}

export function removeDirIfEmpty(dir: string) {
  if (!safeStatSync(dir)?.isDirectory() || readDirectoryEntriesSync(dir).length > 0) {
    return;
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // ignore
  }
}

type OrphanedSessionKeyParams = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  additionalAgentIds?: readonly string[];
  legacySessionSurfaces: PreparedLegacySessionSurfaces | (() => PreparedLegacySessionSurfaces);
};

/** Deferred plugin session migrations, read live inside a Doctor pending check. */
export function readPendingPluginSessionMigrations(env: NodeJS.ProcessEnv) {
  return withArtifactPreservingStateReads(() =>
    withOpenClawStateDatabaseReadSnapshot(async () => readDeferredPluginMigrations({ env }), {
      env,
    }),
  );
}

/**
 * Whether orphaned session keys need canonicalizing, by the migration's own pass without its
 * write. Anything the pass would only warn about is undecidable, since skipping it would drop
 * the warning.
 */
export async function checkOrphanedSessionKeysPending(
  params: OrphanedSessionKeyParams,
): Promise<"work" | "none" | "undecidable"> {
  const pass = await canonicalizeOrphanedSessionKeys(params);
  return pass.legacyStores > 0 ? "work" : pass.warnings.length > 0 ? "undecidable" : "none";
}

export async function migrateOrphanedSessionKeys(
  params: OrphanedSessionKeyParams,
): Promise<MigrationMessages> {
  const { legacyStores: _legacyStores, ...result } = await canonicalizeOrphanedSessionKeys(
    params,
    saveSessionStoreStrict,
  );
  return result;
}

async function canonicalizeOrphanedSessionKeys(
  params: OrphanedSessionKeyParams,
  save?: (storePath: string, store: Record<string, SessionEntry>) => Promise<void>,
): Promise<MigrationMessages & { legacyStores: number }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const recoverableWarnings: string[] = [];
  let legacyStores = 0;
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
  const persistedStoreAgentId =
    persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined;
  const persistedStorePath =
    persistedStoreAgentId && storeConfig
      ? resolveStorePathFromTemplate(storeConfig, persistedStoreAgentId, env)
      : undefined;
  const pluginAgentIds =
    params.additionalAgentIds ??
    (await preparePluginDoctorSessionStoreAgentIds({
      config: params.cfg,
      env,
      pluginIds: collectRelevantDoctorPluginIds(params.cfg),
    }));
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
  if (safeStatSync(agentsDir)?.isDirectory()) {
    for (const dirEntry of readDirectoryEntriesSync(agentsDir)) {
      if (dirEntry.isDirectory()) {
        const diskAgentId = normalizeAgentId(dirEntry.name);
        if (diskAgentId) {
          const diskPath = path.join(agentsDir, diskAgentId, "sessions", "sessions.json");
          addToStoreMap(diskPath, diskAgentId);
        }
      }
    }
  }
  // Read first: the deferred plugin migrations are read only once a legacy store exists.
  const pendingPluginMigrations =
    storeMap.size > 0 ? await readPendingPluginSessionMigrations(env) : [];

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
    const storePath = [...storePaths].find((candidate) => safeStatSync(candidate)?.isFile());
    if (!storePath) {
      continue;
    }
    const pluginForeignMainAliasRisk = [...storeAgentIds].some(
      (id) => pluginAgentIdSet.has(id) && id !== DEFAULT_AGENT_ID,
    );
    let parsed: ReturnType<typeof parseSessionStoreJson5>;
    try {
      parsed = parseSessionStoreJson5(
        decodeUtf8Input(fs.readFileSync(storePath), "Legacy session store"),
      );
    } catch (err) {
      (err instanceof Utf8InputError ? recoverableWarnings : warnings).push(
        `Could not read ${storePath}: ${String(err)}`,
      );
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
        legacyStores,
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
    legacyStores += 1;
    if (!save) {
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
      await save(storePath, normalized);
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
    legacyStores,
  };
}

export function resolveStorePathFromTemplate(
  template: string,
  agentId: string,
  env: NodeJS.ProcessEnv,
): string {
  return path.resolve(expandHomePrefix(template.replaceAll("{agentId}", agentId), { env }));
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
  for (const entry of readDirectoryEntriesSync(agentsDir)) {
    if (entry.isDirectory()) {
      candidateStorePaths.push(path.join(agentsDir, entry.name, "sessions", "sessions.json"));
    }
  }
  const targetStoreAliases = resolveSessionStoreAliasPlan(targetStorePath, candidateStorePaths);
  return { preserveAmbiguousKeys, preserveForeignMainAliases, targetStoreAliases };
}
