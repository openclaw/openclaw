import type { DatabaseSync } from "node:sqlite";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { loadedCronStoreFromRows } from "../cron/store/row-codec.js";
import type { CronJobRow } from "../cron/store/schema.js";
import { compileSqliteQueryBindings, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { readAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { readClawCronRefsInDatabase } from "./cron.js";
import type { AttachedCronJob, ClawMonitorCleanupSnapshot } from "./monitor-cleanup.read.types.js";
import {
  portableHeartbeatDrift,
  portableHeartbeatStateDigest,
  readPortableHeartbeatStateInDatabase,
} from "./portable-heartbeat-state.kernel.js";
import { readClawInstallRecordFromDatabase } from "./provenance-read.kernel.js";

export function readAttachedCronJobsInDatabase(
  db: DatabaseSync,
  agentId: string,
): AttachedCronJob[] {
  const { compiled, bind } = compileSqliteQueryBindings<string>((parameter) => {
    const boundAgentId = parameter((value) => value);
    return getNodeSqliteKysely<Pick<DB, "cron_jobs">>(db)
      .selectFrom("cron_jobs")
      .selectAll()
      .where((eb) =>
        eb.or([eb("agent_id", "=", boundAgentId), eb("owner_agent_id", "=", boundAgentId)]),
      )
      .orderBy("job_id")
      .orderBy("store_key");
  });
  const rows =
    db /* sqlite-allow-raw: preserve native inventory errors outside the write-transaction owner. */
      .prepare(compiled.sql)
      // SAFETY: This SELECT * uses the same cron_jobs schema that defines CronJobRow.
      .all(...bind(agentId)) as CronJobRow[];
  return rows.map((row) => {
    const job = loadedCronStoreFromRows([row]).store.jobs[0];
    return {
      id: row.job_id,
      name: row.name,
      enabled: row.enabled === 1,
      agentId: row.agent_id,
      ownerAgentId: row.owner_agent_id,
      storeKey: row.store_key,
      declarationKey: row.declaration_key,
      revision: job ? resolveCronJobConfigRevision(job) : undefined,
    };
  });
}

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
