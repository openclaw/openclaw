/** Offline Doctor target discovery and legacy-source admission. */
import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { isPrimarySessionTranscriptFileName } from "../config/sessions/artifacts.js";
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
import { canonicalMigrationFilePath } from "../infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import {
  hasOrphanedSqliteSidecars,
  resolveSqliteDatabaseFilePaths,
} from "../infra/sqlite-files.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { createRetainedAgentDatabaseMatcher } from "../state/agent-deletion-discovery.js";
import type { HistoricalArchiveSources } from "./doctor-session-sqlite-discovery.js";
import type {
  DoctorSessionSqliteMode,
  DoctorSessionSqliteOptions,
} from "./doctor-session-sqlite-types.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };

// Direct store migrations are scoped by path; broader agent discovery needs runtime config.
export function resolveDoctorSessionSqliteConfig(
  options: DoctorSessionSqliteOptions,
): OpenClawConfig {
  if (options.cfg) {
    return options.cfg;
  }
  const requestedAgentId = normalizeAgentId(options.agent ?? LEGACY_IMPLICIT_AGENT_ID);
  return options.store
    ? { agents: { entries: { [requestedAgentId]: { default: true } } } }
    : getRuntimeConfig();
}

export function resolveDoctorSessionSqliteMaintenancePaths(
  targets: readonly SessionStoreTarget[],
): string[] {
  const protectedPaths = new Set<string>();
  for (const target of targets) {
    for (const databasePath of resolveSqliteDatabaseFilePaths(resolveTargetSqlitePath(target))) {
      protectedPaths.add(databasePath);
    }
  }
  return [...protectedPaths];
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
    const legacyStorePath = path.join(resolveStateDir(params.env), "sessions", "sessions.json");
    const legacyTargets =
      discoversHistory && fs.existsSync(legacyStorePath)
        ? resolveSessionStoreTargets(params.cfg, { allAgents: true }, { env: params.env }).map(
            (target) => ({
              agentId: target.agentId,
              sqlitePath: resolveTargetSqlitePath(target, params.env),
              storePath: legacyStorePath,
            }),
          )
        : [];
    const targets = [...legacyTargets, ...candidates].map((target) => ({
      target,
      sqlitePath: resolveTargetSqlitePath(target, params.env),
    }));
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
          fs.readdirSync(path.dirname(target.storePath)).some(isPrimarySessionTranscriptFileName))),
  );
}
