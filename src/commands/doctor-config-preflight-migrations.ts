import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DoctorStateMigrationRefusalError,
  throwIfDoctorStateMigrationRefused,
} from "../infra/state-migrations.messages.js";
import type {
  LegacyStateMigrationStepReceipt,
  MigrationMessages,
} from "../infra/state-migrations.types.js";
import {
  canIsolateAgentDatabase,
  evaluateAgentDatabaseAdmissions,
  listAgentDatabaseAdmissionRefusals,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { getAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";

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
