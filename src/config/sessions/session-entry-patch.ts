import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import {
  SqliteWorkerError,
  hasSqliteWorkerOutcomeUnknown,
} from "../../infra/sqlite-worker-contract.js";
import type {
  SqliteWorkerOperationAdmission,
  SqliteWorkerAdmissionRequest,
} from "../../infra/sqlite-worker-operation-admission.js";
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
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
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
  SessionEntryPatchReduction,
  SessionEntryPatchSelection,
} from "./session-entry-patch.types.js";
import {
  prepareSessionSourceAuthority,
  type PreparedSessionSourceAuthority,
} from "./session-source-authority.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export async function patchSessionEntryInWorker(params: {
  database: OpenClawAgentDatabaseOptions & { path: string };
  databaseIdentity?: string;
  agentId: string;
  selection: SessionEntryPatchSelection;
  assertCurrent: () => void;
  guard?: SessionEntryPatchGuard;
  preparedSource?: PreparedSessionSourceAuthority;
  reduction?: SessionEntryPatchReduction;
  prepare(snapshot: SqliteLifecycleTargetSnapshot): Promise<SessionEntryPatchCommit | undefined>;
  onCommitted?: (entry: SessionEntry) => void;
}): Promise<{ entry: SessionEntry | null; wrote: boolean }> {
  let source = params.preparedSource;
  const sourceChecks = source?.checks ?? [];
  const releaseSource = () => {
    const held = source;
    source = undefined;
    return held?.release?.();
  };
  let input: SessionEntryPatchCommit | SessionEntryPatchReduction | undefined = params.reduction;
  return await runSessionEntryWorkerOperation<
    SessionEntryPatchCommitted,
    { entry: SessionEntry | null; wrote: boolean }
  >({
    ...params,
    releaseSource,
    candidateKind: "session-entry-patch",
    assertPrepared: () => {
      params.guard?.assertCurrent?.();
      source?.assertCurrent();
    },
    assertCandidate: (candidate) => {
      if (candidate.refusedSource) {
        sourceChecks[candidate.refusedSource.index]?.refuse(candidate.refusedSource.facts);
        throw new Error("Session source refusal omitted its prepared assertion");
      }
      if (candidate.entry !== null) {
        params.guard?.assertCurrent?.();
        source?.assertCurrent();
      }
    },
    prepareWorker: params.reduction
      ? undefined
      : (execution, executionSource) => ({
          async prepare() {
            params.assertCurrent();
            params.guard?.assertCurrent?.();
            source?.assertCurrent();
            const snapshot = await runOpenClawAgentWorkerWrite(params.database, () =>
              execution.runExisting(executionSource, (worker) =>
                worker.execute({ type: "session.entry.patch.prepare", input: params.selection }),
              ),
            );
            if (!snapshot) {
              throw new Error("Session database disappeared before patching");
            }
            params.assertCurrent();
            params.guard?.assertCurrent?.();
            // The foreground FIFO stays held; async planners may read through it before commit.
            input = await params.prepare(snapshot);
            params.assertCurrent();
            params.guard?.assertCurrent?.();
          },
          beforeWrite() {},
          async release() {},
        }),
    async run(worker, commit) {
      const prepared = input;
      if (!prepared) {
        return { entry: null, wrote: false };
      }
      if (source) {
        prepared.sources = sourceChecks.map((check) => check.predicate);
        source.assertCurrent();
      }
      return commit(() => worker.execute({ type: "session.entry.patch.commit", input: prepared }));
    },
    async onCommitted(committed, published, identity) {
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
      await releaseSource();
      if (committed.entry !== null && params.guard?.source) {
        source = await prepareSessionSourceAuthority(params.guard.source);
        source.assertCurrent();
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
  releaseSource?: () => void | Promise<void>;
  candidateKind: Candidate["kind"];
  retainedExecution?: OpenClawAgentDatabaseExecution;
  prepareWorker?: SessionEntryWorkerPreparation;
  nativeSettlement?: {
    readonly failure?: unknown;
    onAdmission(
      this: void,
      admission: SqliteWorkerOperationAdmission,
      retained: RetainedWorkerTransactionAdmission,
      request: SqliteWorkerAdmissionRequest,
      grant: () => boolean,
    ): boolean;
    readCommitReceipt(receipt: unknown): unknown;
    settle(
      outcome: { ok: true; value: unknown } | { ok: false; error: unknown },
      acknowledged: boolean,
    ): Promise<"committed" | "rolled-back" | "not-entered" | "unknown">;
  };
  run(
    worker: AgentDatabaseExecutionScope,
    commit: (send: () => Promise<unknown>) => Promise<Result>,
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
  let transferId: number | undefined;
  let receiver: ReturnType<typeof createSqliteWorkerTransferReceiver> | undefined;
  let transferred = false;
  let settlement: {
    candidate?: Candidate;
    admitted?: {
      admission: SqliteWorkerOperationAdmission;
      retained: RetainedWorkerTransactionAdmission;
    };
  } = {};
  const matchesReceipt = (raw: unknown) => {
    const receipt = params.nativeSettlement ? params.nativeSettlement.readCommitReceipt(raw) : raw;
    return (
      isRecord(receipt) &&
      receipt.kind === "session-entry-patch-committed" &&
      transferred &&
      receipt.transferId === transferId
    );
  };
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
          // One locked callback may settle several independent commits in this FIFO turn.
          settlement = {};
          transferId = undefined;
          receiver = undefined;
          transferred = false;
          committing = true;
          const outcome = await send().then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let acknowledged = outcome.ok && matchesReceipt(outcome.value);
          let unknown = !outcome.ok && hasSqliteWorkerOutcomeUnknown(outcome.error);
          if (settlement.admitted) {
            await settlement.admitted.retained.settled;
            acknowledged ||= matchesReceipt(settlement.admitted.admission.committed?.facts);
            unknown = settlement.admitted.admission.settlement?.kind !== "completed";
          }
          const nativeOutcome = await params.nativeSettlement?.settle(outcome, acknowledged);
          unknown ||=
            nativeOutcome === "unknown" ||
            Boolean(settlement.admitted && !acknowledged && nativeOutcome !== "rolled-back");
          const committed = acknowledged ? settlement.candidate : undefined;
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
            error.cause =
              publicationError ??
              params.nativeSettlement?.failure ??
              (outcome.ok ? undefined : outcome.error);
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
      if (!isRecord(facts) || !matchesReceipt(facts.publication) || !settlement.candidate) {
        throw new Error("Session patch commit omitted its exact candidate");
      }
      params.assertCandidate?.(settlement.candidate);
      settlement.admitted = { admission, retained };
      const receipt = settlement.candidate.publication;
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
            settlement.candidate ||
            record.kind !== "patch" ||
            !isRecord(record.value) ||
            record.value.kind !== params.candidateKind
          ) {
            throw new Error("Session patch returned an invalid publication candidate");
          }
          // SAFETY: This command's paired kernel supplies the complete candidate through its transfer.
          settlement.candidate = record.value as Candidate;
        });
      } else if (isRecord(value) && value.kind === "session-entry-patch-frame" && receiver) {
        // SAFETY: The receiver validates framing, byte bounds, ordering and record completeness.
        transferred = receiver.accept(value.frame as SqliteWorkerTransferFrame) !== undefined;
      } else {
        throw new Error("Session patch returned unexpected transaction facts");
      }
    },
    params.nativeSettlement?.onAdmission,
    params.releaseSource,
  );
}
