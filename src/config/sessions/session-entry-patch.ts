import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import {
  SqliteWorkerError,
  hasSqliteWorkerOutcomeUnknown,
} from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import {
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
  type SqliteWorkerTransferHandle,
} from "../../infra/sqlite-worker-transfer.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type {
  AgentDatabaseExecutionScope,
  OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution-contract.js";
import { retainSessionEntryWorkerPublication } from "./session-accessor.sqlite-entry-cache.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import {
  withSessionEntryWorker,
  type SessionEntryWorkerPreparation,
} from "./session-accessor.sqlite-replacement-worker.js";
import type {
  SessionEntryPatchCommit,
  SessionEntryPatchCommitted,
  SessionEntryPatchGuard,
  SessionEntryPatchSelection,
  SessionEntryPatchReceipt,
} from "./session-entry-patch.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export async function patchSessionEntryInWorker(params: {
  database: OpenClawAgentDatabaseOptions & { path: string };
  databaseIdentity?: string;
  agentId: string;
  selection: SessionEntryPatchSelection;
  assertCurrent: () => void;
  guard?: SessionEntryPatchGuard;
  prepare(snapshot: SqliteLifecycleTargetSnapshot): Promise<SessionEntryPatchCommit | undefined>;
  onCommitted?: (entry: SessionEntry) => void;
}): Promise<{ entry: SessionEntry | null; wrote: boolean }> {
  return runSessionEntryWorkerOperation<
    SessionEntryPatchCommitted,
    { entry: SessionEntry | null; wrote: boolean }
  >({
    ...params,
    candidateKind: "session-entry-patch",
    assertPrepared: () => params.guard?.assertCurrent?.(),
    assertCandidate: (candidate) => {
      if (candidate.entry !== null) {
        params.guard?.assertCurrent?.();
      }
    },
    async run(worker, commit) {
      const snapshot = await worker.execute({
        type: "session.entry.patch.prepare",
        input: params.selection,
      });
      params.assertCurrent();
      params.guard?.assertCurrent?.();
      const input = await params.prepare(snapshot);
      params.assertCurrent();
      params.guard?.assertCurrent?.();
      return input
        ? commit(() => worker.execute({ type: "session.entry.patch.commit", input }))
        : { entry: null, wrote: false };
    },
    onCommitted(committed, published, identity) {
      try {
        if (committed.publication && committed.entry) {
          params.onCommitted?.(structuredClone(committed.entry));
        }
      } finally {
        if (published) {
          publishCommittedSessionIdentity(
            params.agentId,
            identity,
            published.previous,
            published.current,
            published.prepared,
          );
        }
      }
      return { entry: committed.entry, wrote: Boolean(committed.publication) };
    },
  });
}

export async function runSessionEntryWorkerOperation<
  Candidate extends { kind: string; publication?: SessionEntryReplacementPublication },
  Result,
>(params: {
  database: OpenClawAgentDatabaseOptions & { path: string };
  databaseIdentity?: string;
  agentId: string;
  assertCurrent: () => void;
  assertPrepared?: () => void;
  assertCandidate?: (candidate: Candidate) => void;
  candidateKind: Candidate["kind"];
  retainedExecution?: OpenClawAgentDatabaseExecution;
  prepareWorker?: SessionEntryWorkerPreparation;
  run(
    worker: AgentDatabaseExecutionScope,
    commit: (send: () => Promise<SessionEntryPatchReceipt>) => Promise<Result>,
  ): Promise<Result>;
  onAcknowledged?: (candidate: Candidate) => void;
  onTransactionFacts?: (facts: unknown) => boolean;
  onCommitted(
    candidate: Candidate,
    published: ReturnType<ReturnType<typeof retainSessionEntryWorkerPublication>["settle"]>,
    identity: string,
  ): Result | Promise<Result>;
}): Promise<Result> {
  let publication: ReturnType<typeof retainSessionEntryWorkerPublication> | undefined;
  let committing = false;
  let candidate: Candidate | undefined;
  let transferId: number | undefined;
  let receiver: ReturnType<typeof createSqliteWorkerTransferReceiver> | undefined;
  let transferred = false;
  let admitted:
    | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
    | undefined;
  const matchesReceipt = (receipt: unknown) =>
    isRecord(receipt) &&
    receipt.kind === "session-entry-patch-committed" &&
    transferred &&
    receipt.transferId === transferId;
  return withSessionEntryWorker(
    params.database,
    params.databaseIdentity,
    params.assertCurrent,
    async (execution, source) => {
      await execution.prepare(source);
      params.assertCurrent();
      params.assertPrepared?.();
      const identity = execution.fileIdentity;
      if (!identity) {
        throw new Error("Session patch has no admitted physical database");
      }
      publication = retainSessionEntryWorkerPublication({
        agentId: params.agentId,
        storePath: params.database.path,
        databaseIdentity: identity.physicalIdentity,
      });
      const result = await execution.runExisting(source, (worker) =>
        params.run(worker, async (send) => {
          committing = true;
          const outcome = await send().then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let acknowledged = outcome.ok && matchesReceipt(outcome.value);
          let unknown = !outcome.ok && hasSqliteWorkerOutcomeUnknown(outcome.error);
          if (admitted) {
            await admitted.retained.settled;
            acknowledged ||= matchesReceipt(admitted.admission.committed?.facts);
            unknown = admitted.admission.settlement?.kind !== "completed" || !acknowledged;
          }
          const committed = acknowledged ? candidate : undefined;
          let publicationError: unknown;
          let publishedResult: { value: Result } | undefined;
          try {
            const failures: unknown[] = [];
            try {
              if (committed) {
                params.onAcknowledged?.(committed);
              }
            } catch (error) {
              failures.push(error);
            }
            // Confirmed writes must release publication custody even if acknowledgment work fails.
            try {
              const published = publication?.settle(committed?.publication, unknown);
              if (committed) {
                publishedResult = {
                  value: await params.onCommitted(committed, published, identity.physicalIdentity),
                };
              }
            } catch (error) {
              failures.push(error);
            }
            throwSqliteLifecycleErrors(failures, "Session commit publication failed");
          } catch (error) {
            if (!unknown) {
              throw error;
            }
            publicationError = error;
          }
          if (unknown) {
            const error = new SqliteWorkerError(
              "Session patch has no confirmed native completion and commit receipt",
              "outcome-unknown",
            );
            error.cause = publicationError ?? (outcome.ok ? undefined : outcome.error);
            throw error;
          }
          if (!outcome.ok && !committed) {
            throw outcome.error;
          }
          if (!publishedResult) {
            throw new SqliteWorkerError(
              "Session operation omitted its committed result",
              "outcome-unknown",
            );
          }
          return publishedResult.value;
        }),
      );
      if (result === undefined) {
        throw new Error("Session database disappeared before patching");
      }
      return result;
    },
    (admission, retained, facts) => {
      if (!committing) {
        return;
      }
      if (!isRecord(facts) || !matchesReceipt(facts.publication) || !candidate) {
        throw new Error("Session patch commit omitted its exact candidate");
      }
      params.assertCandidate?.(candidate);
      admitted = { admission, retained };
      const receipt = candidate.publication;
      if (receipt) {
        publication?.begin(
          receipt.changedKeys,
          receipt.membershipInvalidatedKeys,
          receipt.sharingUnchangedKeys,
        );
      }
    },
    params.retainedExecution,
    undefined,
    params.prepareWorker,
    (facts) => {
      if (!isRecord(facts)) {
        return;
      }
      const value = facts.publication;
      if (params.onTransactionFacts?.(value)) {
        return;
      }
      if (!committing) {
        return;
      }
      if (
        value === undefined ||
        (isRecord(value) && value.kind === "session-entry-patch-validated")
      ) {
        params.assertPrepared?.();
      } else if (isRecord(value) && value.kind === "session-entry-patch-transfer") {
        if (
          receiver ||
          !isRecord(value.handle) ||
          typeof value.handle.id !== "number" ||
          !Array.isArray(value.handle.kinds) ||
          value.handle.kinds.length !== 1 ||
          value.handle.kinds[0] !== "patch"
        ) {
          throw new Error("Session patch returned an invalid publication transfer");
        }
        // SAFETY: The paired kernel supplies the validated transfer descriptor.
        const handle = value.handle as SqliteWorkerTransferHandle;
        transferId = handle.id;
        receiver = createSqliteWorkerTransferReceiver(handle, (record) => {
          if (
            candidate ||
            record.kind !== "patch" ||
            !isRecord(record.value) ||
            record.value.kind !== params.candidateKind
          ) {
            throw new Error("Session patch returned an invalid publication candidate");
          }
          // SAFETY: This command's paired kernel supplies the complete candidate through its transfer.
          candidate = record.value as Candidate;
        });
      } else if (isRecord(value) && value.kind === "session-entry-patch-frame" && receiver) {
        // SAFETY: The receiver validates framing, byte bounds, ordering and record completeness.
        transferred = receiver.accept(value.frame as SqliteWorkerTransferFrame) !== undefined;
      } else {
        throw new Error("Session patch returned unexpected transaction facts");
      }
    },
  );
}
