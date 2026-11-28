import path from "node:path";
import {
  buildAcpDatabaseSessionKey,
  selectAcpSessionRow,
} from "../acp/runtime/session-meta-keys.js";
import { selectAcpMigrationRowForStoreEntry } from "../acp/runtime/session-meta-migration-keys.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope-config.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/paths.js";
import type { SessionEntry } from "../config/sessions.js";
import { readLegacyAcpMigrationContext } from "../config/sessions/session-accessor.sqlite-acp-provenance.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets.js";
import type { SessionScope } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { preparePluginDoctorSessionStoreAgentIds } from "../plugins/doctor-contract-preparation.js";
import {
  collectRelevantDoctorPluginIds,
  isPluginDoctorMigrationDeferred,
} from "../plugins/doctor-contract-registry.js";
import type { PreparedLegacySessionSurfaces } from "../plugins/legacy-session-surfaces.types.js";
import {
  LEGACY_IMPLICIT_AGENT_ID as DEFAULT_AGENT_ID,
  normalizeAgentId,
  normalizeMainKey,
} from "../routing/session-key.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  deferredPluginSessionStoreIds,
  prepareDeferredPluginSessionImportReader,
  preserveDeferredPluginSessionSource,
  resolveDeferredPluginSessionStoreSource,
} from "./deferred-plugin-session-sources.js";
import {
  hasLegacyAcpMigrationCompletion,
  legacyAcpMigrationBindingMatches,
  legacyAcpMigrationSourceKey,
  prepareLegacyAcpMigrationSource,
  recordLegacyAcpMigrationCompletion,
} from "./legacy-acp-migration-source.js";
import { safeStatSync } from "./path-guards.js";
import { readSessionStoreJson5 } from "./state-migrations.fs.js";
import {
  resolveLegacyAcpMetadataSessionStoreTargets,
  resolveSessionStoreAliasPlan,
  sessionStorePathsMatch,
} from "./state-migrations.session-store-paths.js";
import {
  aliasedSessionStoreMigrationWarning,
  canonicalizeLegacySessionKeyForAgent,
  distinctSessionStoreAliasWarning,
  normalizeSessionEntry,
  readPendingPluginSessionMigrations,
  resolveStorePathFromTemplate,
  saveSessionStoreStrict,
  unresolvedSessionStoreIdentityWarning,
} from "./state-migrations.session-store.js";
import {
  isAmbiguousSharedStoreKey,
  isLegacyDefaultMainAliasKey,
  resolveCanonicalAgentSessionOwner,
} from "./state-migrations.session-surfaces.js";

type LegacyAcpMetadataInput = Omit<
  Parameters<typeof writeAcpSessionMetaForMigration>[0],
  "database" | "databasePath"
> & {
  sourcePath: string;
  sourceSessionKey: string;
  preserveSource: boolean;
  cfg: OpenClawConfig;
  agentId: string;
  readVerifiedCoreImport: ReturnType<typeof prepareDeferredPluginSessionImportReader>;
};

/** Retained JSON is input history, not authority to reopen a completed ACP import. */
function importLegacyAcpSessionMetadata(params: LegacyAcpMetadataInput): boolean {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return false;
  }
  const databaseKey = buildAcpDatabaseSessionKey(sessionKey, params.agentId);
  const source = prepareLegacyAcpMigrationSource(params);
  const now = params.now?.() ?? Date.now();
  return runOpenClawStateWriteTransaction(
    (database) => {
      if (hasLegacyAcpMigrationCompletion(database.db, source)) {
        return false;
      }
      const coreTarget = params.readVerifiedCoreImport(database.db, params.agentId);
      // Declined file metadata stays consumed after the live database gets its own import receipt.
      let imported = coreTarget.kind !== "stale";
      if (coreTarget.kind === "canonical") {
        const { entry: canonical, sources } = readLegacyAcpMigrationContext({
          agentId: params.agentId,
          storePath: coreTarget.target.sqlitePath,
          sessionKey,
          env: params.env,
        });
        imported =
          legacyAcpMigrationBindingMatches(source, canonical) &&
          !selectAcpMigrationRowForStoreEntry(
            database.db,
            sessionKey,
            params.agentId,
            params.cfg,
            canonical,
          );
        if (
          imported &&
          !sources.some(
            (recorded) =>
              legacyAcpMigrationSourceKey(recorded) === legacyAcpMigrationSourceKey(source) &&
              recorded.sourceSha256 === source.sourceSha256,
          )
        ) {
          throw new Error(
            "Retained ACP import has no matching recorded source provenance; metadata was not replayed.",
          );
        }
      }
      const current = imported ? selectAcpSessionRow(database.db, databaseKey) : undefined;
      if (current) {
        // Without a verified superseding session, only the same lifecycle binding
        // can consume this source. Conflicts must retain both owners' metadata.
        const sourceBinding = source.lifecycleRevision ?? source.sessionId;
        if (!sourceBinding || current.session_id !== sourceBinding) {
          throw new Error(
            "Canonical ACP metadata has a conflicting session binding; resolve the conflict before rerunning Doctor. Legacy metadata was retained.",
          );
        }
        imported = false;
      }
      if (imported) {
        writeAcpSessionMetaForMigration({
          ...params,
          sessionKey: databaseKey,
          database,
          now: () => now,
        });
      }
      if (params.preserveSource) {
        recordLegacyAcpMigrationCompletion(database.db, source, now);
      }
      return imported;
    },
    { env: params.env },
    { operationLabel: "state.import-legacy-acp-metadata" },
  );
}

type LegacyAcpSessionMetadataParams = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  pluginSessionStoreAgentIds?: readonly string[];
  legacySessionSurfaces: PreparedLegacySessionSurfaces;
};

/**
 * Whether legacy ACP metadata remains to import, by the migration's own pass without its import
 * or store rewrite. A source whose rows were already imported counts as work. Anything the pass
 * would only warn about is undecidable.
 */
export async function checkLegacyAcpSessionMetadataPending(
  params: LegacyAcpSessionMetadataParams,
): Promise<"work" | "none" | "undecidable"> {
  const pass = await migrateLegacyAcpSessionMetadataPass(params, false);
  return pass.legacyStores > 0 ? "work" : pass.warnings.length > 0 ? "undecidable" : "none";
}

export async function migrateLegacyAcpSessionMetadata(
  params: LegacyAcpSessionMetadataParams,
): Promise<{ changes: string[]; warnings: string[] }> {
  const { changes, warnings } = await migrateLegacyAcpSessionMetadataPass(params, true);
  return { changes, warnings };
}

async function migrateLegacyAcpSessionMetadataPass(
  params: LegacyAcpSessionMetadataParams,
  apply: boolean,
): Promise<{ changes: string[]; warnings: string[]; legacyStores: number }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  let legacyStores = 0;
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  if (params.legacySessionSurfaces.failures.length > 0) {
    return {
      changes,
      warnings: [...params.legacySessionSurfaces.failures],
      legacyStores,
    };
  }
  const now = params.now ?? (() => Date.now());
  const stateDir = resolveStateDir(env);
  const storeConfig = params.cfg.session?.store;
  const pluginAgentIds =
    params.pluginSessionStoreAgentIds ??
    (await preparePluginDoctorSessionStoreAgentIds({
      config: params.cfg,
      env,
      pluginIds: collectRelevantDoctorPluginIds(params.cfg),
    }));
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
  const scope: SessionScope | undefined = params.cfg.session?.scope;
  const storeGroups: Array<{
    target: (typeof targets)[number];
    sourcePath: string;
    agentIds: Set<string>;
    aliasCandidates: Set<string>;
  }> = [];

  for (const target of targets) {
    // Core import may archive the index while its ACP metadata still awaits the plugin.
    const sourcePath = safeStatSync(target.storePath)?.isFile()
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

  // Read first: the deferred plugin migrations are read only once a source exists.
  const pending = storeGroups.length > 0 ? await readPendingPluginSessionMigrations(env) : [];
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
    // SAFETY: a prototype-free object only ever receives string session keys below.
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
        if (!apply) {
          consumed++;
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
    if (!apply) {
      legacyStores += Number(consumed > 0);
      continue;
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

  return { changes, warnings, legacyStores };
}
