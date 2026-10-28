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
import type { HealthCheck, HealthFinding } from "../flows/health-checks.js";
import { isTransientSqliteBackupPath } from "../infra/backup-volatile-filter.js";
import { prepareStateDatabaseInitialization } from "../state/openclaw-state-db-initialization.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { quarantineAgentDeletionJournal } from "./doctor-agent-deletion-journal-quarantine.js";
import { restoreDoctorMissingJournalStores } from "./doctor-agent-deletion-journal-restore.js";
import type { DoctorDatabasePreflight } from "./doctor-database-preflight.js";

export const agentDeletionJournalHealthCheck: HealthCheck = {
  id: "core/doctor/agent-deletion-journal",
  kind: "core",
  description: "Held agent stores include recovery reasons and restoration guidance.",
  async detect(ctx) {
    const [{ prepareDoctorDatabasePreflight }, { withDoctorLintStateEnv }] = await Promise.all([
      import("./doctor-database-preflight.js"),
      import("./doctor-lint-state-snapshot.js"),
    ]);
    const env = ctx.env ?? process.env;
    return withDoctorLintStateEnv(
      env,
      async () =>
        (
          await repairDoctorAgentDeletionJournal({
            preflight: await prepareDoctorDatabasePreflight(),
            shouldRepair: false,
            env,
          })
        ).findings,
    );
  },
};

/** Doctor alone reconstructs lost deletion history and records the stores it cannot verify. */
export async function repairDoctorAgentDeletionJournal(params: {
  preflight: DoctorDatabasePreflight;
  shouldRepair: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[]; findings: HealthFinding[] }> {
  const discovery = params.preflight.agentDatabaseMigrationDiscovery?.discovery;
  const changes: string[] = [];
  const recoveryWarnings: string[] = [];
  const report = (
    warnings: string[],
    errorCode = "agent-deletion-journal-held",
    severity: HealthFinding["severity"] = "warning",
  ) => ({
    changes,
    warnings,
    findings: warnings.map((message): HealthFinding => ({
      checkId: "core/doctor/agent-deletion-journal",
      severity,
      errorCode,
      message,
      fixHint:
        "Run openclaw doctor --fix to verify ownership and back up configured stores before restoration. For stores still held, follow the reported original-configuration restoration guidance; preserved stores remain untouched.",
    })),
  });
  let quarantined = false;
  if (!discovery) {
    return report([]);
  }
  if (
    discovery.deletionJournal.status === "unavailable" &&
    discovery.deletionJournal.cause === "unreadable" &&
    !params.shouldRepair
  ) {
    return report(
      [
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
      "agent-deletion-journal-unreadable",
    );
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
    return report([]);
  }
  let held = discovery.unverifiedTargets.map(({ agentId, path: pathname }) => ({
    agentId,
    path: pathname,
  }));
  if (missing && discovery.failures.length > 0) {
    return report(
      [
        "Agent deletion journal missing; stores remain held because their recovery inventory is incomplete. Repair the listed paths, then rerun openclaw doctor --fix.",
        ...discovery.failures.map(({ path: pathname, reason }) =>
          sanitizeForLog(`${pathname}: ${reason}`),
        ),
      ],
      "agent-deletion-journal-inventory-incomplete",
    );
  }
  if (missing && params.preflight.agentDatabaseRecoveryConfigValid !== true) {
    return report(
      [
        "Agent deletion journal missing; stores remain held because the ownership configuration could not be verified. Repair the configuration, then rerun openclaw doctor --fix.",
      ],
      "agent-deletion-journal-config-unverified",
    );
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
    return report(recoveryWarnings, "agent-deletion-journal-recovery", "info");
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
          `${target.path}: ${target.agentId} is a reserved system agent and cannot be added or deleted. Run ${formatCliCommand("openclaw doctor --fix", params.env)} to restore its canonical store after ownership, integrity, and backup verification; unverified stores remain untouched.`,
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
          `Run ${formatCliCommand("openclaw doctor --fix", params.env)} to reconstruct the journal and restore verified configured stores automatically after verified backups. Other stores remain held.`,
        ]
      : []),
  ];
  return report(
    warnings,
    missing && !params.shouldRepair ? "agent-deletion-journal-missing" : undefined,
  );
}
