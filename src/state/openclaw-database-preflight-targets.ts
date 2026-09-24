import { resolveStateDir } from "../config/paths.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import {
  discoverAgentDatabaseMigrationTargets,
  type PreparedAgentDatabaseMigrationDiscovery,
} from "../infra/state-migrations.media-persistence-targets.js";
import { isValidAgentId, normalizeAgentId } from "../routing/session-key.js";
import { createAgentDatabaseDeletionClassifier } from "./agent-deletion-discovery.js";
import type {
  AgentDeletionJournalDisposition,
  AgentDeletionJournalPurpose,
} from "./agent-deletion-journal.read.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isPersistentOpenClawAgentDatabasePath,
} from "./openclaw-agent-db.paths.js";
import type { AgentSchemaInspection } from "./openclaw-agent-schema-inspection.js";

type AgentTarget = { agentId: string; path: string };

/** An inspected custom path supplies recovery ownership, never migration admission. */
export function recordAgentDatabaseRecoveryInspection(
  prepared: PreparedAgentDatabaseMigrationDiscovery | undefined,
  pathname: string,
  realPath: string,
  inspection: AgentSchemaInspection,
): void {
  const metadata = inspection.agentSchemaMeta;
  if (
    inspection.failure ||
    inspection.reason ||
    metadata?.role !== "agent" ||
    !metadata.agentId ||
    !isValidAgentId(metadata.agentId)
  ) {
    prepared?.discovery.failures.push({
      path: pathname,
      reason: "Could not verify the owner of a held custom session store.",
    });
  } else {
    prepared?.discovery.unverifiedTargets.push({
      agentId: normalizeAgentId(metadata.agentId),
      path: pathname,
      realPath,
      source: "configured",
    });
  }
}

/** Select read-only inspection targets from the captured shared-state ownership facts. */
export function collectAgentDatabasePreflightTargets(options: {
  env: NodeJS.ProcessEnv;
  registeredDatabases: readonly AgentTarget[];
  deletionJournal: AgentDeletionJournalDisposition;
  purpose: AgentDeletionJournalPurpose;
  configuredAgentDatabaseTargets?:
    | readonly AgentTarget[]
    | ((registered: readonly AgentTarget[]) => readonly AgentTarget[]);
  configuredAgentDatabaseCandidatePaths?: readonly string[];
  inspectCandidateOwners: boolean;
  onAgentDatabaseDiscovery?: (prepared: PreparedAgentDatabaseMigrationDiscovery) => void;
}) {
  const { registeredDatabases, deletionJournal, purpose } = options;
  const retainedDeletions = deletionJournal.status === "present" ? deletionJournal.entries : [];
  let agentTargets = registeredDatabases;
  let configuredTargets: readonly AgentTarget[] = [];
  const retainedAgentIds = new Set(retainedDeletions.map((deletion) => deletion.agentId));
  const retainedPaths = new Set<string>();
  const failures: Array<{ path: string; reason: string }> = [];
  let preparedDiscovery: PreparedAgentDatabaseMigrationDiscovery | undefined;
  if (options.configuredAgentDatabaseTargets !== undefined) {
    // Doctor must resolve configured paths from these read-only facts: the
    // runtime registry reader rejects the very legacy schema Doctor repairs.
    configuredTargets =
      typeof options.configuredAgentDatabaseTargets === "function"
        ? options.configuredAgentDatabaseTargets(registeredDatabases)
        : options.configuredAgentDatabaseTargets;
  }
  if (purpose === "maintenance" && options.configuredAgentDatabaseTargets !== undefined) {
    const discovery = discoverAgentDatabaseMigrationTargets({
      env: options.env,
      configuredAgentDatabaseTargets: configuredTargets,
      registeredAgentDatabases: registeredDatabases,
      deletionJournal,
    });
    preparedDiscovery = {
      stateDir: resolveStateDir(options.env),
      configuredAgentDatabaseTargets: configuredTargets,
      registeredAgentDatabases: registeredDatabases,
      discovery,
    };
    agentTargets = discovery.targets;
    for (const retained of [...discovery.retainedTargets, ...discovery.unverifiedTargets]) {
      retainedPaths.add(retained.realPath);
    }
    failures.push(...discovery.failures);
  }
  // An occupied custom-store candidate can have a newer, unreadable owner.
  // Check its version without promoting it into an owned migration target.
  const candidates: Array<{ agentId?: string; path: string; holdForDeletionRecovery?: true }> = [
    // Migration deduplication must not discard configured ownership claims.
    ...configuredTargets,
    ...agentTargets,
    // Migration discovery intentionally declines ownership of foreign registry
    // paths. Preflight remains read-only, so preserve their downgrade guard.
    ...(options.configuredAgentDatabaseTargets !== undefined
      ? registeredDatabases.filter((database) =>
          isPersistentOpenClawAgentDatabasePath(database.path, options.env),
        )
      : []),
    ...(options.configuredAgentDatabaseCandidatePaths ?? []).map((candidatePath) => ({
      agentId: options.inspectCandidateOwners
        ? resolveUnsuffixedSqliteTargetFromSessionStorePath(candidatePath).agentId
        : undefined,
      path: candidatePath,
    })),
  ];
  const samePath = createOpenClawAgentDatabasePathMatcher();
  const retained = [...retainedPaths];
  const classifyDeletion = createAgentDatabaseDeletionClassifier({
    env: options.env,
    retainedDeletions: deletionJournal,
    configuredAgentDatabaseTargets: configuredTargets,
    registeredAgentDatabases: registeredDatabases,
  });
  return {
    candidates:
      purpose === "runtime"
        ? candidates.filter((row) => typeof classifyDeletion(row.path, row.agentId) !== "object")
        : deletionJournal.status === "unavailable"
          ? preparedDiscovery && options.onAgentDatabaseDiscovery
            ? (options.configuredAgentDatabaseCandidatePaths ?? [])
                .filter((pathname) => !retained.some((candidate) => samePath(candidate, pathname)))
                .map((pathname) => ({
                  agentId: undefined,
                  path: pathname,
                  holdForDeletionRecovery: true as const,
                }))
            : []
          : candidates.filter(
              (row) =>
                (row.agentId === undefined || !retainedAgentIds.has(row.agentId)) &&
                !(
                  deletionJournal.status === "present" &&
                  deletionJournal.held.some((target) => samePath(target.path, row.path))
                ),
            ),
    isRetainedPath: (pathname: string) =>
      purpose === "runtime"
        ? typeof classifyDeletion(pathname) === "object"
        : retained.some((candidate) => samePath(candidate, pathname)),
    failures,
    preparedDiscovery,
  };
}
