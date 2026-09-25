import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import {
  projectSessionSharingEntry,
  type SessionEntryReplacementPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import type { SessionMaintenanceExecutionPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { reclaimSessionMaintenanceInTransaction } from "./session-accessor.sqlite-maintenance-transaction.js";

/** The outer transaction binds the existing maintenance kernel to one broker commit. */
export function executeSessionMaintenanceInWorker(
  plan: SessionMaintenanceExecutionPlan,
  admit: (
    stage: "transaction" | "commit",
    publication?: SessionEntryReplacementPublication,
  ) => void,
) {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      admit("transaction");
      const result = reclaimSessionMaintenanceInTransaction(plan, {});
      const changedKeys =
        result.kind === "maintenance-plan"
          ? result.value.archivedSessionKeys
          : result.kind === "maintenance-finalize"
            ? result.value.committedEntries.map((entry) => entry.sessionKey)
            : [];
      const current = new Map(
        changedKeys.flatMap((key) => {
          const entry = readExactSessionEntryRow(database, key)?.entry;
          return entry ? [[key, projectSessionSharingEntry(entry)] as const] : [];
        }),
      );
      const previous =
        result.kind === "maintenance-finalize"
          ? new Map(
              result.value.committedEntries.flatMap(({ sessionKey, expectedEntry }) =>
                expectedEntry
                  ? [
                      [
                        sessionKey,
                        {
                          sessionId: expectedEntry.sessionId,
                          lifecycleRevision: expectedEntry.lifecycleRevision,
                        },
                      ] as const,
                    ]
                  : [],
              ),
            )
          : new Map(
              [...current].map(([key, entry]) => [
                key,
                {
                  sessionId: entry.sessionId,
                  lifecycleRevision: entry.lifecycleRevision,
                },
              ]),
            );
      const receipt: SessionEntryReplacementPublication = {
        kind: "session-entry-replacements",
        previous,
        current,
        changedKeys,
        membershipInvalidatedKeys: [],
      };
      deferSqliteWorkerCommitReceipt(database.db, receipt);
      admit("commit", receipt);
      return result;
    },
    plan.databaseOptions,
    plan.kind === "maintenance-statistics" ? { busyTimeoutMs: 0 } : undefined,
  );
}
