import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import {
  DoctorStateMigrationRefusalError,
  throwIfDoctorStateMigrationRefused,
} from "../infra/state-migrations.messages.js";
import type {
  LegacyStateMigrationStepReceipt,
  MigrationMessages,
} from "../infra/state-migrations.types.js";
import { setActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
import {
  canIsolateAgentDatabase,
  evaluateAgentDatabaseAdmissions,
  listAgentDatabaseAdmissionRefusals,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { getAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import {
  assertPreflightConfigUnchanged,
  type ConfigPreflightSnapshotRead,
} from "./config-preflight-snapshot.js";
import { runDoctorPluginConvergence } from "./doctor-config-preflight-plugin-verification.js";
import type { PluginMigrationInspection } from "./doctor/shared/plugin-migration-availability.js";

/** Settle package repairs before state migrations select their plugin owners. */
export async function prepareDoctorMigrationPlugins(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  measure?: ConfigSnapshotReadMeasure;
  snapshotRead: ConfigPreflightSnapshotRead;
  readRefreshedSnapshot: () => Promise<ConfigPreflightSnapshotRead>;
  onDeferredPlugins: (
    pending: readonly DeferredPluginMigration[],
    inspection?: PluginMigrationInspection,
  ) => void;
}): Promise<ConfigPreflightSnapshotRead> {
  const convergence = await runDoctorPluginConvergence(params);
  setActiveDegradedPlugins(convergence.quarantinedPlugins);
  params.onDeferredPlugins(convergence.deferredPlugins ?? [], convergence.migrationInspection);
  const refreshed = await params.readRefreshedSnapshot();
  assertPreflightConfigUnchanged(params.snapshotRead.snapshot, refreshed.snapshot);
  return refreshed;
}

export async function assertDoctorPreflightMigrationsComplete(params: {
  cfg: OpenClawConfig;
  stepReceipts: readonly LegacyStateMigrationStepReceipt[];
  report: (result: MigrationMessages) => void;
}): Promise<void> {
  const scopedRefusals = params.stepReceipts.filter(
    (receipt) =>
      receipt.outcome === "refused" &&
      (receipt.refusal?.code === "agent-database-ownership-mismatch" ||
        receipt.refusal?.code === "blocked-by-agent-database-refusal") &&
      receipt.refusedAgentDatabasePaths?.length,
  );
  const admissions =
    scopedRefusals.length > 0
      ? getAgentDatabaseStartupAdmission()
        ? listAgentDatabaseAdmissionRefusals()
        : await evaluateAgentDatabaseAdmissions(params.cfg)
      : [];
  if (scopedRefusals.length > 0) {
    recordAgentDatabaseAdmissions(admissions);
  }
  const isolatedPaths = new Set(
    admissions
      .filter(
        (refusal) =>
          refusal.code !== "agent-database-ownership-mismatch" ||
          canIsolateAgentDatabase(params.cfg, refusal.agentId),
      )
      .flatMap((refusal) => refusal.paths.map((pathname) => path.resolve(pathname))),
  );
  for (const receipt of scopedRefusals) {
    if (
      receipt.refusedAgentDatabasePaths?.every((pathname) =>
        isolatedPaths.has(path.resolve(pathname)),
      )
    ) {
      receipt.outcome = "warning";
    }
  }
  try {
    throwIfDoctorStateMigrationRefused(params.stepReceipts);
  } catch (error) {
    if (error instanceof DoctorStateMigrationRefusalError) {
      // A refused owner stops all later repairs. Still diagnose canonical
      // workspace state read-only before final completion becomes unreachable.
      const { assertConfiguredWorkspaceStateReady } =
        await import("../agents/workspace-state-dirs.js");
      try {
        await assertConfiguredWorkspaceStateReady({ cfg: params.cfg, operation: "doctor" });
      } catch (workspaceError) {
        params.report({ changes: [], warnings: [String(workspaceError)] });
      }
    }
    throw error;
  }
}

export function noteStateMigrationResult(result: MigrationMessages): void {
  for (const key of ["changes", "notices", "warnings"] as const) {
    if (result[key]?.length) {
      note(result[key].map((entry) => `- ${entry}`).join("\n"), `Doctor ${key}`);
    }
  }
}
