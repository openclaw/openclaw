import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok } from "@openclaw/normalization-core/result";
import { sqliteSessionIdWriteScope } from "../../infra/sqlite-database-admission.js";
import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import {
  wrapSqliteWorkerError,
  hasSqliteWorkerOutcomeUnknown,
} from "../../infra/sqlite-worker-contract.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type {
  SqliteWorkerOperationAdmission,
  SqliteWorkerAdmissionRequest,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { createSqliteWorkerTransferCollector } from "../../infra/sqlite-worker-transfer.js";
import { freezeTrustedJsonSnapshot } from "../../shared/immutable-data.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type {
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseExecutionScope,
  OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution-contract.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { retainSessionEntryWorkerPublication } from "./session-accessor.sqlite-entry-cache.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import {
  sqliteSessionEntriesEqual,
  type SqliteLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-equality.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import {
  withSessionEntryWorker,
  type SessionEntryWorkerPreparation,
} from "./session-accessor.sqlite-replacement-worker.js";
import type { SessionEntryCommitContext } from "./session-accessor.types.js";
import { readSessionActorEntryFacts } from "./session-actor-replica.js";
import { projectSessionEntryPatch } from "./session-entry-patch-operation.js";
import type {
  SessionEntryPatchCommit,
  SessionEntryPatchCommitted,
  SessionEntryPatchCommitObserver,
  SessionEntryPatchGuard,
  SessionEntryPatchReduction,
  SessionEntryPatchSelection,
} from "./session-entry-patch.types.js";
import { readRetainedSessionEntryFacts } from "./session-entry-read-facts.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import { attachSessionEntrySnapshots } from "./session-entry-snapshot-values.js";
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import {
  acceptSessionSourceValidation,
  type PreparedSessionSourceAuthority,
  type SessionSourceValidation,
} from "./session-source-authority.js";
import { retainSessionTranscriptWorkerPublication } from "./session-transcript-authority.js";
import type { SessionTranscriptAuthorityReceipt } from "./session-transcript-authority.types.js";
import { collectSessionEntryLookupKeys, normalizeStoreSessionKey } from "./store-entry.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export async function patchSessionEntryInWorker(params: {
  database: OpenClawAgentDatabaseOptions & { path: string };
  databaseIdentity?: string;
  expectedCreationIdentity?: DatabasePathIdentity;
  retainedExecution?: OpenClawAgentDatabaseExecution;
  agentId: string;
  selection: SessionEntryPatchSelection;
  assertCurrent: () => void;
  assertCommitAllowed?: () => void;
  shouldCommit?: () => boolean;
  guard?: SessionEntryPatchGuard;
  preparedSource?: PreparedSessionSourceAuthority;
  reduction?: SessionEntryPatchReduction;
  prepare(snapshot: SqliteLifecycleTargetSnapshot): Promise<SessionEntryPatchCommit | undefined>;
  onCommitted?: SessionEntryPatchCommitObserver;
  onCommittedSource?: (source: CapturedSessionEntryReadSource, entry: SessionEntry) => void;
}): Promise<{ entry: Readonly<SessionEntry> | null; wrote: boolean }> {
  let source = params.preparedSource;
  const sourceChecks = source?.checks ?? [];
  const releaseSource = () => {
    const held = source;
    source = undefined;
    return held?.release?.();
  };
  let input: SessionEntryPatchCommit | SessionEntryPatchReduction | undefined = params.reduction;
  const ensureIdentitySource = params.guard?.ensureIdentitySource;
  let transactionFacts: SessionPendingInputAuthorityFacts | undefined;
  let commitRefusal: Error | undefined;
  let committing = false;
  let retainedEntry: SessionEntry | undefined;
  return await runSessionEntryWorkerOperation<
    SessionEntryPatchCommitted,
    { entry: Readonly<SessionEntry> | null; wrote: boolean }
  >({
    ...params,
    releaseSource,
    candidateKind: "session-entry-patch",
    decodeCandidate(candidate) {
      const delta = candidate.entryDelta;
      if (!delta) {
        return;
      }
      if (!retainedEntry) {
        throw new Error("Session patch delta omitted its retained preimage");
      }
      const entry = { ...retainedEntry, ...Object.fromEntries(delta.values) };
      for (const key of delta.removed) {
        Reflect.deleteProperty(entry, key);
      }
      candidate.publication?.current.set(
        delta.sessionKey,
        attachSessionEntrySnapshots({ ...entry }, {}, "list"),
      );
      if (candidate.publication?.fullEntries) {
        candidate.publication.fullEntries = new Map(candidate.publication.fullEntries).set(
          delta.sessionKey,
          entry,
        );
      }
      const actor = candidate.publication?.actorPostimages?.get(delta.sessionKey);
      if (actor) {
        actor.entry = entry;
      }
      // Internal callers replace fields locally; nested facts belong to the frozen publication.
      // SDK egress owns the fully mutable public copy.
      if (delta.returnEntry) {
        candidate.entry = { ...freezeTrustedJsonSnapshot(entry) };
      }
      delete candidate.entryDelta;
    },
    assertPrepared: () => {
      params.guard?.assertCurrent?.();
      source?.assertCurrent();
    },
    assertCandidate: (candidate) => {
      if (candidate.refusedSource) {
        sourceChecks[candidate.refusedSource.index]?.refuse(candidate.refusedSource.facts);
        throw new Error("Session source refusal omitted its prepared assertion");
      }
      // Omitted results still need authority; only absent/refused selections skip this grant.
      if (candidate.entry !== null) {
        params.assertCommitAllowed?.();
        params.guard?.assertCurrent?.();
        source?.assertCurrent();
        params.guard?.assertMutationAllowed?.();
        if (ensureIdentitySource) {
          if (!transactionFacts) {
            throw new Error("Entry ensure omitted its transaction authority facts");
          }
          ensureIdentitySource.assertCurrent(transactionFacts);
        }
      }
    },
    onTransactionFacts: (value) => {
      if (committing && value === undefined && params.shouldCommit?.() === false) {
        commitRefusal = new Error("Session entry patch was cancelled before mutation");
        throw commitRefusal;
      }
      if (isRecord(value) && value.kind === "session-entry-patch-validated") {
        params.guard?.assertMutationAllowed?.();
      }
      if (source && isRecord(value) && value.kind === "session-entry-patch-validated") {
        // SAFETY: The paired kernel supplies the source indices from this transaction.
        acceptSessionSourceValidation(source, value.sourceValidation as SessionSourceValidation);
      }
      if (
        ensureIdentitySource &&
        isRecord(value) &&
        value.kind === "session-entry-patch-validated"
      ) {
        if (!isRecord(value.authority)) {
          throw new Error("Entry ensure omitted its transaction authority facts");
        }
        // SAFETY: session-entry-patch.worker supplies typed authority from its locked preimage.
        transactionFacts = value.authority as SessionPendingInputAuthorityFacts;
        ensureIdentitySource.assertCurrent(transactionFacts);
      }
      return false;
    },
    prepareWorker: params.reduction
      ? undefined
      : (execution, executionSource) => ({
          async prepare() {
            params.assertCurrent();
            params.guard?.assertCurrent?.();
            source?.assertCurrent();
            const snapshot = await runOpenClawAgentWorkerWrite(params.database, async () => {
              const generation = execution.capturePreparedGenerationClaim();
              const selection = params.selection;
              const sessionKey =
                selection.kind === "entry"
                  ? selection.exact
                    ? selection.sessionKey
                    : selection.sessionKey.trim()
                  : selection.target.canonicalKey;
              const singleEntry =
                selection.kind === "entry" ||
                (sessionKey === normalizeStoreSessionKey(sessionKey) &&
                  selection.target.storeKeys.every((key) => key === sessionKey));
              // Complete current facts already contain the callback's CAS preimage.
              // Alias targets and cold/incomplete facts keep their worker-owned selection.
              const retained =
                singleEntry && generation
                  ? readRetainedSessionEntryFacts(
                      params.database,
                      {
                        sessionKeys: [sessionKey],
                        projection: "full",
                      },
                      generation,
                    )
                  : undefined;
              return (
                retained?.entries ??
                execution.runExisting(executionSource, (worker) =>
                  worker.execute({ type: "session.entry.patch.prepare", input: params.selection }),
                )
              );
            });
            if (!snapshot) {
              throw new Error("Session database disappeared before patching");
            }
            params.assertCurrent();
            params.guard?.assertCurrent?.();
            // Async planning releases the writer FIFO; commit compares the snapshot with current rows.
            input = await params.prepare(snapshot);
            params.assertCurrent();
            params.guard?.assertCurrent?.();
          },
          beforeWrite() {},
        }),
    async run(worker, commit, identity) {
      const prepared = input;
      if (!prepared) {
        return { entry: null, wrote: false };
      }
      if (source) {
        prepared.sources = sourceChecks.map((check) => check.predicate);
        source.assertCurrent();
      }
      const resident = readSessionActorEntryFacts({
        database: identity,
        sessionKey: prepared.sessionKey,
      });
      retainedEntry = resident?.snapshots === "full" ? resident.entry : undefined;
      // The FIFO and replica write token own this synchronous postimage check.
      // Transaction predicates, side effects and commit observers still need the writer.
      if (
        retainedEntry &&
        "operation" in prepared &&
        prepared.preserveActivity &&
        prepared.operation.kind !== "public-fields" &&
        prepared.selection.kind === "entry" &&
        collectSessionEntryLookupKeys(prepared.sessionKey).length === 1 &&
        !prepared.consumePendingReset &&
        !prepared.providerReviewMutation &&
        !prepared.shouldCommitIf &&
        !prepared.cliHistory &&
        !prepared.conversation &&
        !prepared.ensureIdentitySource &&
        !sourceChecks.length &&
        !source?.nativeSource &&
        !params.onCommitted &&
        !params.onCommittedSource
      ) {
        const next = projectSessionEntryPatch({
          ...prepared,
          existing: retainedEntry,
          writeBase: retainedEntry,
        });
        if (!next || sqliteSessionEntriesEqual(next, retainedEntry)) {
          params.assertCurrent();
          params.assertCommitAllowed?.();
          params.guard?.assertCurrent?.();
          source?.assertCurrent();
          params.guard?.assertMutationAllowed?.();
          if (params.shouldCommit?.() === false) {
            return { entry: null, wrote: false };
          }
          return {
            entry: prepared.returnEntry === false ? null : structuredClone(retainedEntry),
            wrote: false,
          };
        }
      }
      if (retainedEntry && resident) {
        prepared.retainedEntry = {
          writeToken: resident.writeToken,
          writeScopes: [
            ...collectSessionEntryLookupKeys(prepared.sessionKey),
            ...resident.dependencySessionIds.map(sqliteSessionIdWriteScope),
          ],
        };
      }
      committing = true;
      return commit(() => worker.execute({ type: "session.entry.patch.commit", input: prepared }));
    },
    onAcknowledged(committed, fileIdentity) {
      if (committed.applied && committed.entry && committed.publication) {
        params.onCommittedSource?.(
          {
            agentId: params.database.agentId,
            path: params.database.path,
            databaseIdentity: fileIdentity.physicalIdentity,
            databaseBirthtime: fileIdentity.birthtime,
          },
          committed.entry,
        );
      }
    },
    async onCommitted(committed, published, identity) {
      try {
        if (committed.applied && committed.entry) {
          if (committed.lifecycleEffects) {
            params.onCommitted?.(
              committed.entry,
              committed.transcriptPredicate,
              committed.lifecycleEffects,
            );
          } else if (committed.transcriptPredicate) {
            params.onCommitted?.(committed.entry, committed.transcriptPredicate);
          } else {
            params.onCommitted?.(committed.entry);
          }
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
      // This write may change its source; callers authorize subsequent effects separately.
      await releaseSource();
      return { entry: committed.entry ?? null, wrote: Boolean(committed.publication) };
    },
  }).catch((error: unknown) => {
    if (error === commitRefusal) {
      return { entry: null, wrote: false };
    }
    throw error;
  });
}

export async function runSessionEntryWorkerOperation<
  Candidate extends {
    kind: string;
    publication?: SessionEntryReplacementPublication;
    transcriptPublication?: readonly SessionTranscriptAuthorityReceipt[];
  },
  Result,
>(params: {
  database: OpenClawAgentDatabaseOptions & { path: string };
  databaseIdentity?: string;
  expectedCreationIdentity?: DatabasePathIdentity;
  agentId: string;
  assertCurrent: () => void;
  assertPrepared?: () => void;
  assertCandidate?: (candidate: Candidate, operation: RetainedWorkerTransactionAdmission) => void;
  decodeCandidate?: (candidate: Candidate) => void;
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
    identity: AgentDatabaseExecutionFileIdentity,
  ): Promise<Result>;
  onAcknowledged?: (candidate: Candidate, fileIdentity: AgentDatabaseExecutionFileIdentity) => void;
  onTransactionFacts?: (facts: unknown) => boolean;
  onCommitted(
    candidate: Candidate,
    published: ReturnType<ReturnType<typeof retainSessionEntryWorkerPublication>["settle"]>,
    identity: string,
    context: SessionEntryCommitContext,
    fileIdentity: AgentDatabaseExecutionFileIdentity,
  ): Result | Promise<Result>;
}): Promise<Result> {
  let publication: ReturnType<typeof retainSessionEntryWorkerPublication> | undefined;
  let transcriptPublication:
    | ReturnType<typeof retainSessionTranscriptWorkerPublication>
    | undefined;
  let committing = false;
  let settlement: {
    candidate?: Candidate;
    admitted?: {
      admission: SqliteWorkerOperationAdmission;
      retained: RetainedWorkerTransactionAdmission;
    };
  } = {};
  const createTransfer = () =>
    createSqliteWorkerTransferCollector("patch", (value) => {
      if (settlement.candidate || !isRecord(value) || value.kind !== params.candidateKind) {
        throw new Error("Session patch returned an invalid publication candidate");
      }
      // SAFETY: This command's paired kernel supplies the complete framed candidate.
      settlement.candidate = value as Candidate;
      params.decodeCandidate?.(settlement.candidate);
    });
  let transfer = createTransfer();
  const matchesReceipt = (raw: unknown) => {
    const receipt = params.nativeSettlement ? params.nativeSettlement.readCommitReceipt(raw) : raw;
    return (
      isRecord(receipt) &&
      receipt.kind === "session-entry-patch-committed" &&
      transfer.completed &&
      receipt.transferId === transfer.id
    );
  };
  return withSessionEntryWorker(
    params.database,
    params.databaseIdentity,
    params.assertCurrent,
    async (execution, source, context) => {
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
      transcriptPublication = retainSessionTranscriptWorkerPublication({
        agentId: params.agentId,
        storePath: params.database.path,
        databaseIdentity: identity.physicalIdentity,
      });
      const result = await execution.runExisting(source, (worker) =>
        params.run(
          worker,
          async (send) => {
            // One locked callback may settle several independent commits in this FIFO turn.
            settlement = {};
            transfer = createTransfer();
            committing = true;
            const outcome = await send().then(ok, err);
            let acknowledged = outcome.ok && matchesReceipt(outcome.value);
            let unknown = !outcome.ok && hasSqliteWorkerOutcomeUnknown(outcome.error);
            let nativeSettlementFailure: unknown;
            if (settlement.admitted) {
              const nativeSettlement = await settlement.admitted.retained.settled;
              if (nativeSettlement.kind !== "completed") {
                nativeSettlementFailure = nativeSettlement.error;
              }
              acknowledged ||= matchesReceipt(settlement.admitted.admission.committed?.facts);
              unknown =
                settlement.admitted.admission.settlement?.kind !== "completed" ||
                (unknown && !acknowledged);
            }
            const nativeOutcome = await params.nativeSettlement?.settle(outcome, acknowledged);
            // Completed native failure without a receipt is rollback, not an unknown write.
            unknown ||=
              nativeOutcome === "unknown" ||
              (!acknowledged &&
                (outcome.ok ||
                  Boolean(
                    settlement.admitted?.admission.committed && nativeOutcome !== "rolled-back",
                  )));
            const committed = acknowledged ? settlement.candidate : undefined;
            let publicationError: unknown;
            let publishedResult: { value: Result } | undefined;
            try {
              const failures: unknown[] = [];
              try {
                if (committed) {
                  params.onAcknowledged?.(committed, identity);
                }
              } catch (error) {
                failures.push(error);
              }
              // Confirmed writes must release publication custody even if acknowledgment work fails.
              try {
                const transcriptChanges = transcriptPublication?.settle(
                  Boolean(committed),
                  unknown,
                );
                const published = publication?.settle(
                  committed?.publication,
                  unknown,
                  transcriptChanges,
                );
                if (committed) {
                  publishedResult = {
                    value: await params.onCommitted(
                      committed,
                      published,
                      identity.physicalIdentity,
                      context,
                      identity,
                    ),
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
            if (!unknown && !outcome.ok && !committed) {
              throw outcome.error;
            }
            if (unknown || !publishedResult) {
              throw wrapSqliteWorkerError(
                "Session patch has no confirmed native completion and commit receipt",
                "outcome-unknown",
                publicationError,
                params.nativeSettlement?.failure,
                nativeSettlementFailure,
                outcome.ok ? undefined : outcome.error,
              );
            }
            return publishedResult.value;
          },
          identity,
        ),
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
      if (isRecord(facts) && isRecord(facts.publication) && facts.publication.transfer) {
        transfer.accept(facts.publication.transfer);
      }
      if (!isRecord(facts) || !matchesReceipt(facts.publication) || !settlement.candidate) {
        throw new Error("Session patch commit omitted its exact candidate");
      }
      params.assertCandidate?.(settlement.candidate, retained);
      settlement.admitted = { admission, retained };
      transcriptPublication?.begin(
        settlement.candidate.publication?.transcriptPublication
          ? undefined
          : settlement.candidate.transcriptPublication,
      );
      const receipt = settlement.candidate.publication;
      if (receipt) {
        publication?.begin(
          receipt.changedKeys,
          receipt.membershipInvalidatedKeys,
          receipt.sharingUnchangedKeys,
          receipt.generationUnchangedKeys,
          receipt.transcriptPublication,
          new Map(
            [...receipt.current].filter(
              ([key]) => !receipt.unavailableParticipantKeys?.includes(key),
            ),
          ),
          receipt.conversationPublication,
          receipt.fullEntries,
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
        transfer.accept(value.transfer);
      } else {
        throw new Error("Session patch returned unexpected transaction facts");
      }
    },
    params.nativeSettlement?.onAdmission,
    params.releaseSource,
    "write",
    params.expectedCreationIdentity,
  );
}
