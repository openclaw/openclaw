import path from "node:path";
import { maintenanceLane } from "../config/sessions/session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import { resolveSqliteInspectionSignal } from "../infra/sqlite-readonly-worker.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-snapshot-source.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type {
  DoctorSessionRecoveryDiagnostic,
  DoctorSessionRecoveryTarget,
} from "./doctor-session-recovery.types.js";

/** Explicit offline inputs; Doctor repair, config loading, and Gateway admission are not involved. */
export async function inspectDoctorSessionRecovery(
  options: DoctorSessionRecoveryTarget & { agentDb: string; stateDb: string },
): Promise<DoctorSessionRecoveryDiagnostic> {
  const { agentDb, stateDb } = options;
  const target: DoctorSessionRecoveryTarget = {
    agentId: options.agentId,
    sessionKey: options.sessionKey,
    sessionId: options.sessionId,
    lifecycleRevision: options.lifecycleRevision,
    placementGeneration: options.placementGeneration,
  };
  if (
    !path.isAbsolute(agentDb) ||
    !path.isAbsolute(stateDb) ||
    !target.sessionId.trim() ||
    !target.lifecycleRevision.trim() ||
    !Number.isSafeInteger(target.placementGeneration) ||
    target.placementGeneration < 0 ||
    parseAgentSessionKey(target.sessionKey)?.agentId !== target.agentId
  ) {
    throw new Error(
      "Recovery inspection requires absolute database paths and exact agent/key/SID/lifecycle/generation selectors.",
    );
  }
  const snapshots: PreparedSqliteReadOnlyLocation[] = [];
  let outcome: { value: DoctorSessionRecoveryDiagnostic } | { error: unknown };
  try {
    // The canonical snapshot owner reads committed WAL pages without opening source sidecars.
    // The supplied pair must come from one protected capture; this command cannot certify live custody.
    for (const pathname of [agentDb, stateDb]) {
      snapshots.push(
        await prepareSqliteReadOnlyLocation(pathname, {
          preserveSourceArtifacts: true,
          signal: resolveSqliteInspectionSignal(),
        }),
      );
    }
    const [agent, state] = snapshots;
    if (!agent || !state) {
      throw new Error("Recovery inspection snapshots are unavailable.");
    }
    // Ancillary admission readers must stay inside the diagnostic's private snapshot directory.
    const env = { OPENCLAW_STATE_DIR: path.dirname(state.location) };
    const value = await withSessionHistoryWorkerDatabase(
      { agentId: target.agentId, path: agent.location, env },
      (owner) => owner.readDoctorSessionRecovery({ target, statePath: state.location, env }),
      maintenanceLane,
    );
    outcome = { value };
  } catch (error) {
    outcome = { error };
  }
  const cleanup = await Promise.allSettled(snapshots.map((snapshot) => snapshot.cleanupAsync()));
  if (cleanup.some((result) => result.status === "rejected" || !result.value)) {
    throw new Error("Recovery inspection snapshot cleanup is incomplete.");
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}
