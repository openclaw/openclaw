/** Offline Doctor target discovery and legacy-source admission. */
import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreCandidateTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveConfiguredAgentDatabaseTargets,
  resolveSessionStoreTargets,
  type SessionStoreTarget as ResolvedSessionStoreTarget,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  canonicalMigrationFilePath,
  type SessionSqliteMigrationTargetInput,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  projectExistingAgentDatabaseTargets,
  resolveTargetSqlitePath,
} from "../infra/session-sqlite-migration-readers.js";
import {
  hasOrphanedSqliteSidecars,
  resolveSqliteDatabaseFilePaths,
} from "../infra/sqlite-files.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { createRetainedAgentDatabaseMatcher } from "../state/agent-deletion-discovery.js";
import { readAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { HistoricalArchiveSources } from "./doctor-session-sqlite-discovery.js";
import type {
  DoctorSessionSqliteMode,
  DoctorSessionSqliteOptions,
} from "./doctor-session-sqlite-types.js";
import {
  assertDoctorSqliteMaintenancePathsNotAliased,
  isDestructiveDoctorSessionSqliteMode,
  type DoctorSqliteMaintenanceAuthority,
} from "./doctor-sqlite-maintenance-lock.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };

export async function prepareDoctorSessionSqliteTargets(
  params: DoctorSessionSqliteOptions & {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    authority?: DoctorSqliteMaintenanceAuthority;
  },
) {
  const resolved = resolveDoctorSessionSqliteTargets(params);
  if (isDestructiveDoctorSessionSqliteMode(params.mode)) {
    assertDoctorSqliteMaintenancePathsNotAliased(
      `session SQLite ${params.mode}`,
      resolveDoctorSessionSqliteMaintenancePaths(resolved.targets),
      resolveDoctorSessionSqliteMaintenanceRoots(resolved.targets, params.env),
    );
  }
  const repairEntryStates = async (targets: readonly SessionStoreTarget[]) => {
    params.authority?.assertCurrent();
    const { repairLegacySessionEntryStates } = await import("./doctor-session-delivery-state.js");
    return await repairLegacySessionEntryStates({
      apply: true,
      cfg: params.cfg,
      env: params.env,
      authority: params.authority,
      targets: projectExistingAgentDatabaseTargets(targets, params.env, params.cfg),
      deferSchemaRepair: params.mode === "import",
    });
  };
  if (params.mode === "import") {
    await repairEntryStates(resolved.targets);
  }
  // Recovery reuses this preparation only after restoring or repairing each physical target.
  return { ...resolved, repairEntryStates };
}

export function createMigrationTargetInput(
  target: SessionStoreTarget,
): SessionSqliteMigrationTargetInput {
  return {
    agentId: target.agentId,
    sqlitePath: canonicalMigrationFilePath(resolveTargetSqlitePath(target)),
    storePath: canonicalMigrationFilePath(target.storePath),
  };
}

// Direct store migrations are scoped by path; broader agent discovery needs runtime config.
export function resolveDoctorSessionSqliteConfig(
  options: DoctorSessionSqliteOptions,
): OpenClawConfig {
  if (options.cfg) {
    return options.cfg;
  }
  const requestedAgentId = normalizeAgentId(options.agent ?? LEGACY_IMPLICIT_AGENT_ID);
  return options.store ? { agents: { entries: { [requestedAgentId]: {} } } } : getRuntimeConfig();
}

export function resolveDoctorSessionSqliteMaintenancePaths(
  targets: readonly SessionStoreTarget[],
): string[] {
  return [
    ...new Set(
      targets.flatMap((target) => resolveSqliteDatabaseFilePaths(resolveTargetSqlitePath(target))),
    ),
  ];
}

export function resolveDoctorSessionSqliteMaintenanceRoots(
  targets: readonly SessionStoreTarget[],
  env: NodeJS.ProcessEnv,
): string[] {
  const stateDir = path.resolve(resolveStateDir(env));
  const roots = new Set([stateDir]);
  for (const target of targets) {
    const sqlitePath = resolveTargetSqlitePath(target);
    if (isPathWithin(stateDir, target.storePath) && isPathWithin(stateDir, sqlitePath)) {
      continue;
    }
    const commonRoot = commonPathAncestor(path.dirname(target.storePath), path.dirname(sqlitePath));
    const parentRoot = path.dirname(commonRoot);
    roots.add(parentRoot === path.parse(commonRoot).root ? commonRoot : parentRoot);
  }
  return [...roots];
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  return isPathInside(rootPath, path.resolve(candidatePath));
}

function commonPathAncestor(leftPath: string, rightPath: string): string {
  let currentPath = path.resolve(leftPath);
  const resolvedRightPath = path.resolve(rightPath);
  while (!isPathWithin(currentPath, resolvedRightPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return currentPath;
    }
    currentPath = parentPath;
  }
  return currentPath;
}

export function resolveDoctorSessionSqliteTargets(params: {
  allAgents?: boolean;
  agent?: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode: DoctorSessionSqliteMode;
  store?: string;
}): { targets: SessionStoreTarget[]; knownTargets?: SessionStoreTarget[] } {
  if (params.store) {
    return {
      targets: resolveSessionStoreTargets(
        params.cfg,
        { store: params.store, agent: params.agent, allAgents: params.allAgents },
        { env: params.env },
      ),
    };
  }
  const discoversHistory =
    params.mode === "dry-run" || params.mode === "import" || params.mode === "validate";
  if (
    params.mode === "restore" ||
    params.mode === "recover" ||
    (discoversHistory && params.agent)
  ) {
    const candidates = resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, {
      env: params.env,
    });
    if (!params.agent) {
      return { targets: candidates, knownTargets: candidates };
    }
    const requestedAgentId = normalizeAgentId(params.agent);
    return {
      targets: candidates.filter((target) => normalizeAgentId(target.agentId) === requestedAgentId),
      knownTargets: candidates,
    };
  }
  if (params.agent) {
    return {
      targets: resolveAgentSessionStoreTargetsSync(params.cfg, params.agent, { env: params.env }),
    };
  }
  if (params.allAgents) {
    // Discovery must admit validated directories even before either registry exists.
    const candidates = discoversHistory
      ? resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, { env: params.env })
      : resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env });
    const discovered = candidates.map((target) => ({
      target,
      sqlitePath: resolveTargetSqlitePath(target, params.env),
    }));
    const deletedAgents =
      params.mode === "import"
        ? (withExistingOpenClawStateDatabaseCurrentReadOnly(
            (database) => {
              const deleted = new Set<string>();
              for (const agentId of new Set(
                discovered.map(({ target }) => normalizeAgentId(target.agentId)),
              )) {
                const journal = readAgentDeletionJournalInDatabase(database, agentId, "runtime");
                if (journal?.cleanupCompleted && journal.deleteFiles) {
                  deleted.add(agentId);
                }
              }
              return deleted;
            },
            { env: params.env },
          ) ?? new Set<string>())
        : new Set<string>();
    // A completed delete-files tombstone owns the identity even when verified import
    // archives remain. Automatic history discovery must not recreate that agent.
    const targets = discovered.filter(
      ({ target }) => !deletedAgents.has(normalizeAgentId(target.agentId)),
    );
    const isRetained = createRetainedAgentDatabaseMatcher(
      params.env,
      () => resolveConfiguredAgentDatabaseTargets(params.cfg, { env: params.env }),
      {
        kind: "legacy-database",
        readDatabasePaths: () => targets.map(({ sqlitePath }) => sqlitePath),
      },
    );
    return {
      targets: targets
        .filter(({ target, sqlitePath }) => {
          const orphanedSidecars = hasOrphanedSqliteSidecars(sqlitePath);
          return [target.storePath, sqlitePath].every((pathname) => {
            const disposition = isRetained(pathname, target.agentId);
            // Unknown history is not a deletion; an incomplete SQLite family still needs recovery.
            return !disposition || (disposition === "unavailable" && !orphanedSidecars);
          });
        })
        .map(({ target }) => target),
      knownTargets: targets.map(({ target }) => target),
    };
  }
  return { targets: resolveSessionStoreTargets(params.cfg, {}, { env: params.env }) };
}

export function filterLegacySessionStoreTargets(
  targets: SessionStoreTarget[],
  mode: DoctorSessionSqliteMode,
  historicalArchives: HistoricalArchiveSources,
  settledStores: ReadonlySet<string>,
): SessionStoreTarget[] {
  if (mode === "inspect" || mode === "compact" || mode === "restore" || mode === "recover") {
    return targets;
  }
  return targets.filter(
    (target) =>
      !target.storePath.endsWith(".sqlite") &&
      (settledStores.has(target.storePath) ||
        fs.existsSync(target.storePath) ||
        (historicalArchives.get(canonicalMigrationFilePath(target.storePath))?.transcripts.length ??
          0) > 0 ||
        (fs.existsSync(path.dirname(target.storePath)) &&
          fs.readdirSync(path.dirname(target.storePath)).some((file) => file.endsWith(".jsonl")))),
  );
}
