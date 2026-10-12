import path from "node:path";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { createConfigIO } from "../config/io.js";
import { isTransientSqliteBackupPath } from "../infra/backup-volatile-filter.js";
import { prepareStateDatabaseInitialization } from "../state/openclaw-state-db-initialization.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { quarantineAgentDeletionJournal } from "./doctor-agent-deletion-journal-quarantine.js";
import type { DoctorDatabasePreflight } from "./doctor-database-preflight.js";

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
    if (params.preflight.pendingMigrations?.some((entry) => entry.kind === "state")) {
      const { prepareLegacyStateDatabaseSchema } =
        await import("../infra/state-migrations.doctor.js");
      const { throwIfDoctorStateMigrationRefused } =
        await import("../infra/state-migrations.messages.js");
      throwIfDoctorStateMigrationRefused([await prepareLegacyStateDatabaseSchema(params.env)]);
    }
    const recovery = await quarantineAgentDeletionJournal({
      inventory: [...discovery.targets, ...discovery.retainedTargets, ...held],
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
  }
  if (held.length === 0 && (!missing || params.shouldRepair)) {
    return { changes, warnings: [] };
  }
  const snapshot = await createConfigIO({
    env: params.env,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
  const warnings = [
    ...recoveryWarnings,
    `Warning: Agent deletion journal ${missing && !params.shouldRepair ? "missing" : quarantined ? "quarantined" : recoveryWarnings.length > 0 ? "unusable" : "reconstructed"}; ${held.length} store${held.length === 1 ? "" : "s"} held back. Updates can continue; held stores remain untouched.`,
    ...held.map((target) => {
      if (isTransientSqliteBackupPath(target.path)) {
        return sanitizeForLog(
          `${target.path}: internal SQLite coordination artifact; preserved without agent restoration or deletion.`,
        );
      }
      if (isReservedSystemAgentId(target.agentId)) {
        return sanitizeForLog(
          `${target.path}: ${target.agentId} is a reserved system agent and cannot be added or deleted. Its store remains untouched; review its deletion recovery receipt, then run ${formatCliCommand("openclaw doctor --fix", params.env)}.`,
        );
      }
      const workspace = resolveAgentWorkspaceDir(snapshot.sourceConfig, target.agentId, params.env);
      const agentDir = listAgentIds(snapshot.sourceConfig).includes(target.agentId)
        ? resolveAgentDir(snapshot.sourceConfig, target.agentId, params.env)
        : path.dirname(target.path);
      const restore = formatCliCommand(
        `openclaw agents add ${quote(target.agentId)} --workspace ${quote(workspace)} --agent-dir ${quote(agentDir)} --non-interactive`,
        params.env,
      );
      return sanitizeForLog(
        `${target.path}: ${path.basename(target.path) === "openclaw-agent.sqlite" ? "verify the workspace" : "restore the original session.store configuration for this database and verify the workspace"}, then run ${restore} to abort deletion and restore; after restoration, run ${formatCliCommand(`openclaw agents delete ${quote(target.agentId)} --force`, params.env)} to confirm deletion instead.`,
      );
    }),
    ...(missing && !params.shouldRepair
      ? [
          `Run ${formatCliCommand("openclaw doctor --fix", params.env)} to reconstruct the journal without activating held stores.`,
        ]
      : []),
  ];
  return { changes, warnings };
}
