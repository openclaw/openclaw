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
import { reconstructAgentDeletionJournal } from "../state/agent-deletion-journal-recovery.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { DoctorDatabasePreflight } from "./doctor-database-preflight.js";

/** Doctor alone reconstructs lost deletion history and records the stores it cannot verify. */
export async function repairDoctorAgentDeletionJournal(params: {
  preflight: DoctorDatabasePreflight;
  shouldRepair: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const discovery = params.preflight.agentDatabaseMigrationDiscovery?.discovery;
  const changes: string[] = [];
  if (!discovery) {
    return { changes, warnings: [] };
  }
  const missing = discovery.deletionJournal.status === "unavailable";
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
  if (missing && params.shouldRepair) {
    if (params.preflight.pendingMigrations?.some((entry) => entry.kind === "state")) {
      const { prepareLegacyStateDatabaseSchema } =
        await import("../infra/state-migrations.doctor.js");
      const { throwIfDoctorStateMigrationRefused } =
        await import("../infra/state-migrations.messages.js");
      throwIfDoctorStateMigrationRefused([await prepareLegacyStateDatabaseSchema(params.env)]);
    }
    held = runOpenClawStateWriteTransaction(
      (database) => {
        const wasMissing = !tableExists(database.db, "agent_deletion_journal");
        const remaining = reconstructAgentDeletionJournal(database, held);
        if (wasMissing) {
          changes.push(
            "Reconstructed the missing agent deletion journal and recorded a Doctor receipt listing held stores.",
          );
        }
        return remaining;
      },
      { env: params.env },
    );
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
    `Agent deletion journal ${missing && !params.shouldRepair ? "missing" : "reconstructed"}; ${held.length} store${held.length === 1 ? "" : "s"} held back.`,
    ...held.map((target) => {
      const workspace = resolveAgentWorkspaceDir(snapshot.sourceConfig, target.agentId, params.env);
      const agentDir = listAgentIds(snapshot.sourceConfig).includes(target.agentId)
        ? resolveAgentDir(snapshot.sourceConfig, target.agentId, params.env)
        : path.dirname(target.path);
      const restore = formatCliCommand(
        `openclaw agents add ${quote(target.agentId)} --workspace ${quote(workspace)} --agent-dir ${quote(agentDir)} --non-interactive`,
        params.env,
      );
      return sanitizeForLog(
        `${target.path}: ${path.basename(target.path) === "openclaw-agent.sqlite" ? "verify the workspace" : "restore the original session.store configuration for this database and verify the workspace"}, then run ${restore} to restore; use openclaw agents delete to confirm deletion instead.`,
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
