import { existsSync } from "node:fs";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { formatCliCommand } from "../cli/command-format.js";
import { createConfigIO } from "../config/io.js";
import { readOnlyOpenWouldCreateSqliteSidecars } from "../infra/sqlite-files.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import { isStatePostgres } from "../state/openclaw-state-db-engine.js";
import { prepareStateDatabaseInitialization } from "../state/openclaw-state-db-initialization.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { formatHeldAgentStoreGuidance } from "./doctor-agent-deletion-held.js";
import {
  quarantineAgentDeletionJournal,
  readAgentDeletionJournalRecoverySource,
} from "./doctor-agent-deletion-journal-quarantine.js";
import { restoreDoctorMissingJournalStores } from "./doctor-agent-deletion-journal-restore.js";
import type { DoctorDatabasePreflight } from "./doctor-database-preflight.js";
import type { DoctorMaintenancePending } from "./doctor-maintenance-pending.js";

/**
 * Read-only: whether {@link repairDoctorAgentDeletionJournal} would write under `--fix`.
 * It follows the repair's gates on the prepared discovery (a missing journal that is not a
 * fresh install, stores it holds back for verification) and reads the journal rows the
 * quarantine inspects, without copying the state database. It cannot read PostgreSQL rows
 * here, nor a store no connection holds open (that read would create its WAL sidecars).
 */
export function checkDoctorAgentDeletionJournalPending(params: {
  preflight: DoctorDatabasePreflight;
  env: NodeJS.ProcessEnv;
}): DoctorMaintenancePending {
  const discovery = params.preflight.agentDatabaseMigrationDiscovery?.discovery;
  if (!discovery) {
    return "none";
  }
  const statePath = resolveOpenClawStateSqlitePath(params.env);
  const missing =
    discovery.deletionJournal.status === "unavailable" &&
    discovery.deletionJournal.cause === "missing";
  if (missing) {
    // The repair only warns when the inventory or the ownership config is incomplete.
    if (
      discovery.failures.length > 0 ||
      (discovery.unverifiedTargets.length === 0 &&
        prepareStateDatabaseInitialization(statePath, params.env).kind === "fresh") ||
      params.preflight.agentDatabaseRecoveryConfigValid !== true
    ) {
      return "none";
    }
    return "work";
  }
  if (discovery.unverifiedTargets.length > 0) {
    return "work";
  }
  if (isStatePostgres() || isArtifactPreservingStateRead()) {
    return "undecidable";
  }
  if (!existsSync(statePath)) {
    return "none";
  }
  if (readOnlyOpenWouldCreateSqliteSidecars(statePath)) {
    return "undecidable";
  }
  const source = withExistingOpenClawStateDatabaseReadOnly(readAgentDeletionJournalRecoverySource, {
    env: params.env,
  });
  return source && (source.missing || source.invalid.length > 0) ? "work" : "none";
}

/** Doctor alone reconstructs lost deletion history and records the stores it cannot verify. */
export async function repairDoctorAgentDeletionJournal(params: {
  preflight: DoctorDatabasePreflight;
  shouldRepair: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const discovery = params.preflight.agentDatabaseMigrationDiscovery?.discovery;
  const changes: string[] = [];
  const recoveryWarnings: string[] = [];
  let quarantined = false;
  if (!discovery) {
    return { changes, warnings: [] };
  }
  if (
    discovery.deletionJournal.status === "unavailable" &&
    discovery.deletionJournal.cause === "unreadable" &&
    !params.shouldRepair
  ) {
    return {
      changes,
      warnings: [
        sanitizeForLog(
          `${resolveOpenClawStateSqlitePath(params.env)}: ${discovery.deletionJournal.reason}. Stores remain held; restore verified deletion history, then rerun openclaw doctor --fix.`,
        ),
        ...[...discovery.retainedTargets, ...discovery.unverifiedTargets].map(
          ({ agentId, path: pathname }) =>
            sanitizeForLog(
              `Held agent ${agentId} database ${pathname}; deletion history needs repair.`,
            ),
        ),
      ],
    };
  }
  const missing =
    discovery.deletionJournal.status === "unavailable" &&
    discovery.deletionJournal.cause === "missing";
  if (
    missing &&
    discovery.unverifiedTargets.length === 0 &&
    discovery.failures.length === 0 &&
    prepareStateDatabaseInitialization(resolveOpenClawStateSqlitePath(params.env), params.env)
      .kind === "fresh"
  ) {
    return { changes, warnings: [] };
  }
  let held = discovery.unverifiedTargets.map(({ agentId, path: pathname }) => ({
    agentId,
    path: pathname,
  }));
  if (missing && discovery.failures.length > 0) {
    return {
      changes,
      warnings: [
        "Agent deletion journal missing; stores remain held because their recovery inventory is incomplete. Repair the listed paths, then rerun openclaw doctor --fix.",
        ...discovery.failures.map(({ path: pathname, reason }) =>
          sanitizeForLog(`${pathname}: ${reason}`),
        ),
      ],
    };
  }
  if (missing && params.preflight.agentDatabaseRecoveryConfigValid !== true) {
    return {
      changes,
      warnings: [
        "Agent deletion journal missing; stores remain held because the ownership configuration could not be verified. Repair the configuration, then rerun openclaw doctor --fix.",
      ],
    };
  }
  if (params.shouldRepair) {
    const recovery = await quarantineAgentDeletionJournal({
      inventory: [...discovery.targets, ...discovery.retainedTargets, ...held],
      configuredTargets:
        params.preflight.agentDatabaseMigrationDiscovery?.configuredAgentDatabaseTargets ?? [],
      env: params.env,
    });
    if (recovery) {
      quarantined = !missing && recovery.warnings.length === 0;
      recoveryWarnings.push(...recovery.warnings.map((warning) => sanitizeForLog(warning)));
      held = recovery.held;
      changes.push(
        missing
          ? "Reconstructed the missing agent deletion journal and recorded a Doctor receipt listing held stores."
          : quarantined
            ? "Quarantined unusable agent deletion journal records and recorded a Doctor receipt listing held stores."
            : "Preserved unusable agent deletion journal records in place and recorded a Doctor receipt listing held stores.",
      );
      changes.push(
        ...recovery.archives.map((archive) =>
          sanitizeForLog(`Saved deletion recovery receipt: ${archive}`),
        ),
      );
    }
    const automatic = await restoreDoctorMissingJournalStores({ env: params.env, held });
    changes.push(...automatic.changes.map(sanitizeForLog));
    recoveryWarnings.push(...automatic.warnings.map(sanitizeForLog));
    held = held.filter(
      (target) =>
        !automatic.restored.some(
          (restored) => restored.agentId === target.agentId && restored.path === target.path,
        ),
    );
  }
  if (held.length === 0 && (!missing || params.shouldRepair)) {
    return { changes, warnings: recoveryWarnings };
  }
  const snapshot = await createConfigIO({
    env: params.env,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  const warnings = [
    ...recoveryWarnings,
    `Warning: Agent deletion journal ${missing && !params.shouldRepair ? "missing" : quarantined ? "quarantined" : recoveryWarnings.length > 0 ? "unusable" : "reconstructed"}; ${held.length} store${held.length === 1 ? "" : "s"} held back. Updates can continue; held stores remain untouched.`,
    ...held.map((target) =>
      formatHeldAgentStoreGuidance(target, snapshot.sourceConfig, params.env),
    ),
    ...(missing && !params.shouldRepair
      ? [
          `Run ${formatCliCommand("openclaw doctor --fix", params.env)} to reconstruct the journal and restore verified configured stores automatically after verified backups. Other stores remain held.`,
        ]
      : []),
  ];
  return { changes, warnings };
}
