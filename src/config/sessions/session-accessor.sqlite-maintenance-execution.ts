import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { runExclusiveSqliteTranscriptArchiveWorker } from "./session-accessor.sqlite-archive.js";
import {
  retainSessionEntryWorkerPublication,
  type SessionEntryReplacementPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import type {
  SessionMaintenanceExecutionPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  rejectUnknownSessionWriteOutcome,
  withSessionEntryWorker,
} from "./session-accessor.sqlite-replacement-worker.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";

type SessionMaintenanceWorkerParams = {
  databaseIdentity: string;
  options: OpenClawAgentDatabaseOptions & { path: string };
  plan: SessionMaintenanceExecutionPlan;
  assertCurrent: () => void;
  onResult?: (result: SqliteSessionReclamationResult) => void;
};

/** Retain archive-before-writer ordering and the shared whole-buffer execution limit. */
export function runSessionMaintenanceInWorker(
  params: SessionMaintenanceWorkerParams,
): Promise<SqliteSessionReclamationResult> {
  return withSqliteMutationWorkerLifetime(params.options, ({ assertCurrent, signal }) =>
    runExclusiveSqliteTranscriptArchiveWorker(
      () =>
        runRetainedSessionMaintenanceInWorker({
          ...params,
          assertCurrent() {
            assertCurrent();
            params.assertCurrent();
          },
        }),
      signal,
    ),
  );
}

async function runRetainedSessionMaintenanceInWorker(
  params: SessionMaintenanceWorkerParams,
): Promise<SqliteSessionReclamationResult> {
  const publication = retainSessionEntryWorkerPublication({
    agentId: params.options.agentId,
    storePath: params.options.path,
    databaseIdentity: params.databaseIdentity,
  });
  let admitted:
    | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
    | undefined;
  return withSessionEntryWorker(
    params.options,
    params.databaseIdentity,
    params.assertCurrent,
    async (execution, source) => {
      const result = await execution.runExisting(source, async (worker) => {
        const outcome = await worker
          .execute({ type: "session.maintenance", input: params.plan })
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        let unknown = outcome.ok;
        if (admitted) {
          // Join result delivery and drain native facts before deciding whether work completed.
          await admitted.retained.settled;
          const facts = admitted.admission.committed?.facts;
          let receipt: SessionEntryReplacementPublication | undefined;
          if (isRecord(facts) && facts.kind === "session-entry-replacements") {
            // SAFETY: The paired maintenance kernel produces this retained command's receipt.
            receipt = facts as SessionEntryReplacementPublication;
          }
          unknown = admitted.admission.settlement?.kind !== "completed" || !receipt;
          const published = publication.settle(receipt, unknown);
          if (published) {
            publishCommittedSessionIdentity(
              params.options.agentId,
              published.previous,
              published.current,
            );
          }
        }
        if (unknown) {
          rejectUnknownSessionWriteOutcome(
            "Session maintenance has no confirmed native completion and commit receipt",
            outcome.ok ? undefined : outcome.error,
          );
        }
        if (!outcome.ok) {
          throw outcome.error;
        }
        params.onResult?.(outcome.value);
        return outcome.value;
      });
      if (!result) {
        throw new Error("Session maintenance lost its committed database");
      }
      return result;
    },
    (admission, retained, facts) => {
      if (
        !isRecord(facts) ||
        !isRecord(facts.publication) ||
        facts.publication.kind !== "session-entry-replacements" ||
        !Array.isArray(facts.publication.changedKeys) ||
        !facts.publication.changedKeys.every((key): key is string => typeof key === "string") ||
        !Array.isArray(facts.publication.membershipInvalidatedKeys) ||
        !facts.publication.membershipInvalidatedKeys.every(
          (key): key is string => typeof key === "string",
        )
      ) {
        throw new Error("Session maintenance omitted its publication keys");
      }
      admitted = { admission, retained };
      publication.begin(facts.publication.changedKeys, facts.publication.membershipInvalidatedKeys);
    },
  );
}
