/** Offline Doctor target discovery and legacy-source admission. */
import fs from "node:fs";
import path from "node:path";
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
import { normalizeAgentId } from "../routing/session-key.js";
import { createAgentDatabaseDeletionClassifier } from "../state/agent-deletion-discovery.js";
import { readAgentDatabaseDeletionSnapshot } from "../state/agent-deletion-journal.read.js";
import type { HistoricalArchiveSources } from "./doctor-session-sqlite-discovery.js";
import { canonicalMigrationFilePath } from "./doctor-session-sqlite-migration-run.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
import type { DoctorSessionSqliteMode } from "./doctor-session-sqlite-types.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };

export function resolveDoctorSessionSqliteTargets(params: {
  allAgents?: boolean;
  agent?: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode: DoctorSessionSqliteMode;
  store?: string;
}): SessionStoreTarget[] {
  if (params.store) {
    return resolveSessionStoreTargets(params.cfg, { store: params.store }, { env: params.env });
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
      return candidates;
    }
    const requestedAgentId = normalizeAgentId(params.agent);
    return candidates.filter((target) => normalizeAgentId(target.agentId) === requestedAgentId);
  }
  if (params.agent) {
    return resolveAgentSessionStoreTargetsSync(params.cfg, params.agent, { env: params.env });
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
    // Legacy-only installs can predate shared state; existing history owns retained-store admission.
    const deletionSnapshot = readAgentDatabaseDeletionSnapshot(params.env);
    const isRetained =
      deletionSnapshot &&
      createAgentDatabaseDeletionClassifier({
        env: params.env,
        retainedDeletions: deletionSnapshot.retainedDeletions,
        registeredAgentDatabases: deletionSnapshot.registeredAgentDatabases,
        configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(params.cfg, {
          env: params.env,
        }),
      });
    return [...legacyTargets, ...candidates].filter(
      (target) =>
        !isRetained?.(target.storePath, target.agentId) &&
        !isRetained?.(resolveTargetSqlitePath(target, params.env), target.agentId),
    );
  }
  return resolveSessionStoreTargets(params.cfg, {}, { env: params.env });
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
