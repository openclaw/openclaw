import type { DatabaseSync } from "node:sqlite";
import { readAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import { readClawCronRefsInDatabase } from "./cron.js";
import { readAttachedCronJobsInDatabase } from "./lifecycle-delete-support.js";
import type { ClawMonitorCleanupSnapshot } from "./monitor-cleanup.read.types.js";
import {
  portableHeartbeatDrift,
  portableHeartbeatStateDigest,
  readPortableHeartbeatStateInDatabase,
} from "./portable-heartbeat-state.kernel.js";
import { readClawInstallRecordFromDatabase } from "./provenance-read.kernel.js";

/** One admitted snapshot binds removal ownership to the exact attached definitions and scratch. */
export function readClawMonitorCleanupSnapshotInDatabase(
  db: DatabaseSync,
  input: { agentId: string; storePath: string },
): ClawMonitorCleanupSnapshot {
  const portable = readPortableHeartbeatStateInDatabase(db, input.agentId, input.storePath);
  return {
    journal: readAgentDeletionJournalInDatabase({ db }, input.agentId),
    install: readClawInstallRecordFromDatabase(db, input.agentId),
    attached: readAttachedCronJobsInDatabase(db, input.agentId),
    refs: readClawCronRefsInDatabase(db, input.agentId),
    portable: {
      jobId: portable.receipt?.jobId,
      owned: !portableHeartbeatDrift(portable),
      stateDigest: portableHeartbeatStateDigest(portable),
    },
  };
}
