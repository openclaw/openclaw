import fs from "node:fs";
import path from "node:path";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope-config.js";
import { normalizePersistedSessionEntryShape } from "../commands/doctor/shared/session-entry-shape.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/paths.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolvePersistedSessionStoreOwner } from "../config/sessions/session-store-owner.js";
import { assertSupportedSessionStoreEntry } from "../config/sessions/supported-session-store.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets.js";
import type { SessionScope } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectRelevantDoctorPluginIds,
  isPluginDoctorMigrationDeferred,
  listPluginDoctorSessionStoreAgentIds,
} from "../plugins/doctor-contract-registry.js";
import {
  LEGACY_IMPLICIT_AGENT_ID as DEFAULT_AGENT_ID,
  normalizeAgentId,
  normalizeMainKey,
} from "../routing/session-key.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { readDeferredPluginMigrations } from "./deferred-plugin-migrations.js";
import {
  deferredPluginSessionStoreIds,
  prepareDeferredPluginSessionImportReader,
  preserveDeferredPluginSessionSource,
  resolveDeferredPluginSessionStoreSource,
} from "./deferred-plugin-session-sources.js";
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
  canonicalizeLegacySessionKeyForAgent,
  canonicalizeSessionStore,
  isAmbiguousSharedStoreKey,
  sessionStoreMayNeedCanonicalization,
} from "./state-migrations.session-key-canonicalization.js";
import { resolveStorePathFromTemplate } from "./state-migrations.session-store-ownership.js";
import {
  resolveLegacyAcpMetadataSessionStoreTargets,
  resolveSessionStoreAliasPlan,
  sessionStorePathsMatch,
} from "./state-migrations.session-store-paths.js";
import {
  isLegacyDefaultMainAliasKey,
  resolveCanonicalAgentSessionOwner,
  type PreparedLegacySessionSurfaces,
} from "./state-migrations.session-surfaces.js";
import type { MigrationMessages } from "./state-migrations.types.js";
import { decodeUtf8Input, Utf8InputError } from "./utf8-input.js";

export {
  canonicalizeSessionStore,
  isAmbiguousSharedStoreKey,
  listLegacySessionKeys,
} from "./state-migrations.session-key-canonicalization.js";

export {
  mergeSessionStoreAliasPlans,
  resolveSessionStoreOwnership,
  type SessionStoreOwnership,
} from "./state-migrations.session-store-ownership.js";

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
    ? {
        ...params.cfg,
        agents: {
          ...params.cfg.agents,
          entries: toAgentEntriesRecord([
            ...configuredAgents,
            ...[...declaredAgentIds]
              .filter((agentId) => !configuredAgentIds.has(agentId))
              .map((id) => ({ id })),
          ]),
        },
      }
    : params.cfg;
  // Reuse the validated resolver for every declared owner. Owner multiplicity
  // is restored below as metadata without re-adding rejected raw paths.
  const targets = resolveLegacyAcpMetadataSessionStoreTargets(discoveryCfg, env);
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const scope = params.cfg.session?.scope as SessionScope | undefined;
  const storeGroups: Array<{
    target: (typeof targets)[number];
    sourcePath: string;
    agentIds: Set<string>;
    aliasCandidates: Set<string>;
  }> = [];

  for (const target of targets) {
    // Core import may archive the index while its ACP metadata still awaits the plugin.
    const sourcePath = migrationFileExists(target.storePath)
      ? target.storePath
      : resolveDeferredPluginSessionStoreSource({ target, env });
    if (!sourcePath) {
      continue;
    }
    let group = storeGroups.find(({ target: existing }) =>
      sessionStorePathsMatch(existing.storePath, target.storePath),
    );
    const matchingDeclaredTargets = declaredTargets.filter((declaredTarget) =>
      sessionStorePathsMatch(target.storePath, declaredTarget.storePath),
    );
    if (!group) {
      group = { target, sourcePath, agentIds: new Set(), aliasCandidates: new Set() };
      storeGroups.push(group);
    }
    group.agentIds.add(normalizeAgentId(target.agentId));
    group.aliasCandidates.add(target.storePath);
    for (const declaredTarget of matchingDeclaredTargets) {
      group.agentIds.add(declaredTarget.agentId);
      group.aliasCandidates.add(declaredTarget.storePath);
    }
  }

  for (const { target, sourcePath, agentIds, aliasCandidates } of storeGroups) {
    const storePath = target.storePath;
    if (deferredPluginSessionStoreIds({ target, pending }).some(isPluginDoctorMigrationDeferred)) {
      continue;
    }
    // An archived index is read-only evidence; consumption is recorded, never rewritten.
    const preserveSource =
      sourcePath !== storePath ||
      preserveDeferredPluginSessionSource({ cfg: params.cfg, env, target, pending });
    const storeAliases = resolveSessionStoreAliasPlan(storePath, aliasCandidates);
    const pluginForeignMainAliasRisk = pluginTargets.some((pluginTarget) =>
      sessionStorePathsMatch(storePath, pluginTarget.storePath),
    );
    const parsed = readSessionStoreJson5(sourcePath);
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
        const canonicalSessionKey = canonicalizeLegacySessionKeyForAgent({
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

export async function saveSessionStoreStrict(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  await saveLegacySessionStore(storePath, store, {
    skipMaintenance: true,
  });
}
