// Continuation custody store API (RFC docs/design/continue-work-signal-v2.md
// §5.4). Every operation is one shared-state worker command, and so one state
// write transaction serialized through the worker broker's FIFO. After a
// commit this module installs the reported live sets into the hot-path
// projection and releases the payload files whose references the commit
// scrubbed. Nothing else reads or writes `continuation_records`.
import { uuidv7 } from "../../../../packages/agent-core/src/harness/session/uuid.js";
import { createSqliteWorkerWriteAdmission } from "../../../infra/sqlite-worker-store.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../../state/openclaw-state-worker-store.js";
import {
  assertContinuationCustodyLifetime,
  continuationCustodyLifetime,
  invalidateContinuationCustodyLifetime,
} from "./custody-lifetime.js";
import {
  releaseContinuationCustodyPayload,
  storeContinuationCustodyPayload,
  type ContinuationCustodyPayload,
} from "./custody-payload-store.js";
import {
  hydrateContinuationCustodyProjection,
  installContinuationCustodyCommit,
  invalidateContinuationCustodyOwners,
  isContinuationCustodyProjectionHydrated,
} from "./custody-projection.js";
import type {
  ContinuationClaimResult,
  ContinuationCommitFacts,
  ContinuationCreateResult,
  ContinuationDeleteResult,
  ContinuationElection,
  ContinuationElectionResult,
  ContinuationNoticeSettlementInput,
  ContinuationNoticeSettlementResult,
  ContinuationPayloadConflict,
  ContinuationPostCompactionReleaseInput,
  ContinuationPostCompactionReleaseResult,
  ContinuationPruneResult,
  ContinuationRecord,
  ContinuationRecordPatch,
  ContinuationRecordQuery,
  ContinuationRecordUpdate,
  ContinuationUpdateResult,
  NewContinuationRecord,
} from "./custody-store.types.js";
import type { ContinuationCustodyWorkerOperations } from "./custody-store.worker-contract.js";

/**
 * A new record id. Listings order ties on `created_at` by `record_id`, so ids
 * sort in creation order (monotonic UUIDv7) and same-millisecond records keep
 * the order their writers created them in.
 */
export function newContinuationRecordId(): string {
  return uuidv7();
}

export type ContinuationCustodyStoreOptions = { env?: NodeJS.ProcessEnv };

/** Attachment bytes for a new delegate record; the store binds them to the record. */
export type ContinuationCustodyPayloadInput = Pick<
  ContinuationCustodyPayload,
  "attachments" | "attachAs"
>;

type Operations = ContinuationCustodyWorkerOperations;

type Custody = { context: OpenClawStateWorkerContext; env: NodeJS.ProcessEnv };

function capture(options?: ContinuationCustodyStoreOptions): Custody {
  const env = options?.env ?? process.env;
  return { context: captureOpenClawStateWorkerContext({ env }), env };
}

function databasePath(custody: Custody): string {
  return custody.context.admission.databasePath;
}

function hasCommitFacts(value: unknown): value is ContinuationCommitFacts {
  return typeof value === "object" && value !== null && "owners" in value;
}

/**
 * The raw boot read, the only command that does not wait for phase A. Phase A
 * issues it itself, so fencing it would recurse. Every other command, public
 * list reads included, waits for the projection to be hydrated.
 */
const BOOT_READ_COMMANDS: ReadonlySet<keyof Operations> = new Set<keyof Operations>([
  "continuationCustody.readBootFacts",
]);

/** Watch the database this custody context admits; returns the lifetime's epoch. */
function watchDatabaseLifetime(custody: Custody): number {
  const path = databasePath(custody);
  const lifetime = continuationCustodyLifetime(path);
  if (!lifetime.unwatch) {
    // Match a close by identity key or by canonical path: a watcher installed
    // before the database file existed captured a provisional `path:` identity,
    // while a later path-scoped close reports the physical `file:` identity.
    const captured = custody.context.admission.identity;
    lifetime.unwatch = registerOpenClawStateDatabaseAsyncResource({
      close: async (identity) => {
        if (
          !identity ||
          identity.key === captured.key ||
          identity.canonicalPath === captured.canonicalPath ||
          identity.canonicalPath === path
        ) {
          invalidateContinuationCustodyLifetime(path);
        }
      },
    });
  }
  return lifetime.epoch;
}

/**
 * Phase A of custody readiness (§5.4.5): read the live set in one transaction
 * and hydrate the projection from it. A thrown read installs nothing, so no
 * write passes.
 */
async function readBootFactsAndInstall(custody: Custody): Promise<ContinuationRecord[]> {
  const epoch = watchDatabaseLifetime(custody);
  const facts = await execute(custody, "continuationCustody.readBootFacts", {}, []);
  // A database closed or replaced while this ran must not receive these facts.
  assertContinuationCustodyLifetime(databasePath(custody), epoch);
  hydrateContinuationCustodyProjection(databasePath(custody), facts.live);
  return facts.live;
}

/**
 * Every custody command except the raw boot read waits for phase A, so no
 * write can land, and no list can answer, before the projection is hydrated.
 * The shared promise is only the in-flight read: it is dropped once it settles, so
 * a failed read lets no write through and the next write retries it, and a
 * reset projection is re-read rather than trusted.
 */
async function ensureReady(custody: Custody): Promise<void> {
  const path = databasePath(custody);
  if (isContinuationCustodyProjectionHydrated(path)) {
    return;
  }
  const lifetime = continuationCustodyLifetime(path);
  let pending = lifetime.readiness;
  if (!pending) {
    const started: Promise<void> = readBootFactsAndInstall(custody)
      .then(() => undefined)
      .finally(() => {
        // Only its own entry: an ended lifetime may already have a newer phase A.
        if (lifetime.readiness === started) {
          lifetime.readiness = undefined;
        }
      });
    lifetime.readiness = started;
    pending = started;
  }
  await pending;
}

/** Wait for custody phase A, so the projection describes committed custody. */
export async function whenContinuationCustodyReady(
  options?: ContinuationCustodyStoreOptions,
): Promise<void> {
  await ensureReady(capture(options));
}

/**
 * Run one custody command. A thrown command may or may not have committed, so
 * its owners become unknown in the projection until a later committed fact.
 */
async function execute<Key extends keyof Operations>(
  custody: Custody,
  type: Key,
  input: Operations[Key]["input"],
  touchedOwners: readonly string[],
): Promise<Operations[Key]["output"]> {
  if (!BOOT_READ_COMMANDS.has(type)) {
    await ensureReady(custody);
  }
  let output: Operations[Key]["output"];
  try {
    const assertCurrent = () => custody.context.admission.assertCurrent();
    output = await runOpenClawStateWorkerOperation(
      custody.context,
      (scope) => scope.execute({ type, input }),
      {
        assertCurrent,
        // The worker asks for authority after BEGIN and again before COMMIT.
        createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [databasePath(custody)]),
      },
    );
  } catch (error) {
    invalidateContinuationCustodyOwners(databasePath(custody), touchedOwners);
    throw error;
  }
  if (hasCommitFacts(output)) {
    installContinuationCustodyCommit(databasePath(custody), output.owners, output.ended);
    await releaseScrubbedPayloads(custody, output);
  }
  return output;
}

/**
 * Payload release follows the commit that scrubbed the reference. A failed
 * release leaves an unreferenced file for the startup reconcile, never a
 * record pointing at a missing file.
 */
async function releaseScrubbedPayloads(
  custody: Custody,
  facts: ContinuationCommitFacts,
): Promise<void> {
  for (const { attachmentId, recordId } of facts.releasedAttachments) {
    try {
      await releaseContinuationCustodyPayload(attachmentId, recordId, custody.env);
    } catch {
      // The startup reconcile removes files that no live record references.
    }
  }
}

/**
 * Durable create keyed by owner and kind (RFC §5.4.8 capability 1). A payload
 * is written once, before the record commits (crash boundary 0), and released
 * again when the record ID already exists without referencing it. A payload
 * already stored under the attachment ID is reused only when byte-identical
 * (a retry); any other file there is a `payload_conflict` and nothing is
 * written. After a thrown create the record may have committed, so the file
 * stays for the startup reconcile to judge.
 */
export async function createContinuationRecord(
  record: NewContinuationRecord,
  options?: ContinuationCustodyStoreOptions & { payload?: ContinuationCustodyPayloadInput },
): Promise<ContinuationCreateResult | ContinuationPayloadConflict> {
  const custody = capture(options);
  const payload = options?.payload;
  if (payload) {
    if (record.attachmentId === undefined) {
      throw new Error("continuation custody payload needs the record's attachment id");
    }
    const stored = await storeContinuationCustodyPayload(
      {
        ...payload,
        attachmentId: record.attachmentId,
        recordId: record.recordId,
        ownerKey: record.ownerSessionKey,
      },
      custody.env,
    );
    if (stored === "conflict") {
      return {
        outcome: "payload_conflict",
        recordId: record.recordId,
        attachmentId: record.attachmentId,
      };
    }
  }
  const result = await execute(custody, "continuationCustody.create", { record }, [
    record.ownerSessionKey,
  ]);
  // Release only a payload the existing record does not reference: a retry
  // after an unseen commit meets its own record and must keep that file. The
  // file here is bound to this record ID, so no other record can own it.
  if (
    result.outcome === "exists" &&
    payload &&
    record.attachmentId !== undefined &&
    result.attachmentId !== record.attachmentId
  ) {
    await releaseScrubbedPayloads(custody, {
      owners: [],
      releasedAttachments: [{ recordId: record.recordId, attachmentId: record.attachmentId }],
      ended: [],
    });
  }
  return result;
}

/** Revision CAS on one record, or an all-or-nothing multi-record CAS (rollback). */
export async function updateContinuationRecords(
  updates: readonly ContinuationRecordUpdate[],
  params: { now: number },
  options?: ContinuationCustodyStoreOptions,
): Promise<ContinuationUpdateResult> {
  return execute(
    capture(options),
    "continuationCustody.update",
    { updates: [...updates], now: params.now },
    updates.map((update) => update.ownerSessionKey),
  );
}

type LifecycleTarget = {
  recordId: string;
  ownerSessionKey: string;
  expectedRevision: number;
  now: number;
};

function transition(
  target: LifecycleTarget,
  patch: ContinuationRecordPatch,
  options?: ContinuationCustodyStoreOptions,
): Promise<ContinuationUpdateResult> {
  return updateContinuationRecords(
    [
      {
        recordId: target.recordId,
        ownerSessionKey: target.ownerSessionKey,
        expectedRevision: target.expectedRevision,
        patch,
      },
    ],
    { now: target.now },
    options,
  );
}

/** Fail with a reason, optionally leaving a terminal-notice obligation (RFC §5.4.2). */
export function failContinuationRecord(
  target: LifecycleTarget & {
    failureReason: string;
  } & Pick<ContinuationRecordPatch, "phase" | "stateJson" | "terminalNoticePending">,
  options?: ContinuationCustodyStoreOptions,
): Promise<ContinuationUpdateResult> {
  const { failureReason, phase, stateJson, terminalNoticePending } = target;
  return transition(
    target,
    {
      status: "failed",
      failureReason,
      ...(phase !== undefined ? { phase } : {}),
      ...(stateJson !== undefined ? { stateJson } : {}),
      ...(terminalNoticePending !== undefined ? { terminalNoticePending } : {}),
    },
    options,
  );
}

/** Set the "do not drive" fence without ending the record (C's cancel request). */
export function requestContinuationRecordCancel(
  target: LifecycleTarget,
  options?: ContinuationCustodyStoreOptions,
): Promise<ContinuationUpdateResult> {
  return transition(target, { cancelRequestedAt: target.now }, options);
}

/** Delete an unaccepted record at its exact revision. */
export function deleteContinuationRecord(
  target: Omit<LifecycleTarget, "now">,
  options?: ContinuationCustodyStoreOptions,
): Promise<ContinuationDeleteResult> {
  return execute(
    capture(options),
    "continuationCustody.delete",
    { recordId: target.recordId, expectedRevision: target.expectedRevision },
    [target.ownerSessionKey],
  );
}

export type ContinuationElectionPlan = Pick<ContinuationElection, "supersede" | "create">;

/**
 * Elect same-session work, replacing parked work (RFC §5.4.3). The planner
 * sees the owner's live work records, as C's caller did, and rejects the
 * `running_owner`, `capped` and `invalid_prior` cases itself. The worker then
 * rereads and writes in one transaction. An owner or revision conflict is
 * replanned once, as at C.
 */
export async function electContinuationWork<Rejection>(
  params: {
    ownerSessionKey: string;
    now: () => number;
    plan: (
      live: readonly ContinuationRecord[],
    ) => ContinuationElectionPlan | { rejected: Rejection };
  },
  options?: ContinuationCustodyStoreOptions,
): Promise<ContinuationElectionResult | { outcome: "rejected"; rejection: Rejection }> {
  const custody = capture(options);
  let result: ContinuationElectionResult | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const live = (
      await execute(
        custody,
        "continuationCustody.list",
        {
          ownerSessionKey: params.ownerSessionKey,
          kinds: ["work"],
          statuses: ["queued", "running"],
        },
        [params.ownerSessionKey],
      )
    ).filter((record) => record.cancelRequestedAt === undefined);
    const plan = params.plan(live);
    if ("rejected" in plan) {
      return { outcome: "rejected", rejection: plan.rejected };
    }
    result = await execute(
      custody,
      "continuationCustody.elect",
      {
        ownerSessionKey: params.ownerSessionKey,
        expectedLive: live.map((record) => ({
          recordId: record.recordId,
          revision: record.revision,
          // SAFETY: the list selected only live statuses.
          status: record.status as "queued" | "running",
        })),
        supersede: plan.supersede,
        create: plan.create,
        now: params.now(),
      },
      [params.ownerSessionKey],
    );
    if (
      result.outcome !== "owner_changed" &&
      result.outcome !== "revision_conflict" &&
      result.outcome !== "not_found"
    ) {
      return result;
    }
  }
  // SAFETY: the loop body assigns result before any iteration can finish.
  return result as ContinuationElectionResult;
}

/** Claim a queued delegate and record its next spawn attempt before spawning. */
export function claimContinuationSpawnAttempt(
  target: LifecycleTarget,
  options?: ContinuationCustodyStoreOptions,
): Promise<ContinuationClaimResult> {
  return execute(
    capture(options),
    "continuationCustody.claimSpawnAttempt",
    { recordId: target.recordId, expectedRevision: target.expectedRevision, now: target.now },
    [target.ownerSessionKey],
  );
}

/** Record the failure phase of the latest spawn attempt, with an optional CAS patch. */
export function recordContinuationSpawnAttemptFailure(
  target: LifecycleTarget & {
    attemptId: number;
    failurePhase: "initialize" | "dispatch" | "register";
    patch?: ContinuationRecordPatch;
  },
  options?: ContinuationCustodyStoreOptions,
): Promise<ContinuationUpdateResult> {
  const { recordId, expectedRevision, attemptId, failurePhase, patch, now } = target;
  return execute(
    capture(options),
    "continuationCustody.recordSpawnAttemptFailure",
    { recordId, expectedRevision, attemptId, failurePhase, now, ...(patch ? { patch } : {}) },
    [target.ownerSessionKey],
  );
}

/**
 * Deliver one terminal notice obligation: the notice row insert and the
 * obligation clear are one commit (RFC §5.4.2).
 */
export function settleContinuationNotice(
  input: ContinuationNoticeSettlementInput,
  options?: ContinuationCustodyStoreOptions,
): Promise<ContinuationNoticeSettlementResult> {
  return execute(capture(options), "continuationCustody.settleNotice", input, [
    input.ownerSessionKey,
  ]);
}

/** Release a claimed post-compaction record into the session queue in one commit (RFC §4.4). */
export function releaseContinuationPostCompaction(
  input: ContinuationPostCompactionReleaseInput,
  options?: ContinuationCustodyStoreOptions,
): Promise<ContinuationPostCompactionReleaseResult> {
  return execute(capture(options), "continuationCustody.releasePostCompaction", input, [
    input.ownerSessionKey,
  ]);
}

/** List-by-owner and recovery scans, ordered FIFO by creation (RFC §5.4.6). */
export function listContinuationRecords(
  query: ContinuationRecordQuery,
  options?: ContinuationCustodyStoreOptions,
): Promise<ContinuationRecord[]> {
  return execute(capture(options), "continuationCustody.list", { ...query }, []);
}

/**
 * The same listing over an existing store with no worker and no writer: an artifact-preserving
 * read-only snapshot, so the store's bytes and its WAL and shared-memory files stay as they were.
 * For offline inspection of a stopped store (`openclaw continuations fence-status`); a missing state
 * database lists nothing.
 */
export async function listContinuationRecordsReadOnly(
  query: ContinuationRecordQuery,
  options?: ContinuationCustodyStoreOptions,
): Promise<ContinuationRecord[]> {
  const [{ withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync }, worker] =
    await Promise.all([
      import("../../../state/openclaw-state-db-readonly.js"),
      import("./custody-store.worker.js"),
    ]);
  return (
    (await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
      ({ db }) => worker.listContinuationRecordsInDatabase(db, query),
      { env: options?.env ?? process.env },
    )) ?? []
  );
}

/**
 * Hydrate the hot-path projection from one committed read (phase A), even when
 * already hydrated. Mutations run it on demand.
 */
export async function hydrateContinuationCustody(
  options?: ContinuationCustodyStoreOptions,
): Promise<ContinuationRecord[]> {
  return await readBootFactsAndInstall(capture(options));
}

/** Retention: prune terminal records that ended before the cutoff and owe no notice. */
export function pruneContinuationRecords(
  params: { endedBefore: number },
  options?: ContinuationCustodyStoreOptions,
): Promise<ContinuationPruneResult> {
  return execute(capture(options), "continuationCustody.prune", params, []);
}

/** The database path that keys this store's projection for the given options. */
export function resolveContinuationCustodyDatabasePath(
  options?: ContinuationCustodyStoreOptions,
): string {
  return databasePath(capture(options));
}
