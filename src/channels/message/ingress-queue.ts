import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { resolveChannelIngressStateEnv } from "./ingress-queue-client.js";
import { invalidateChannelIngressHealth } from "./ingress-queue-health-cache.js";
import {
  baseRecord,
  CHANNEL_INGRESS_CLAIM_SCAN_PAGE_BUDGET,
  channelIngressPrefixRowFingerprint,
  claimedRecord,
  completedRecord,
  corruptClaimRecord,
  decodeClaimColumns,
  failedRecord,
  selectChannelIngressClaim,
  xorChannelIngressPrefixFingerprints,
} from "./ingress-queue.codec.js";
import type {
  ChannelIngressClaimCursor,
  ChannelIngressClaimRequest,
  ChannelIngressListInput,
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
  ChannelIngressRow,
  CreateChannelIngressQueueOptions,
} from "./ingress-queue.types.js";
import type { ChannelIngressWorkerOperations } from "./ingress-queue.worker-contract.js";

export type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueClaimRef,
  ChannelIngressQueueCorruptClaim,
  ChannelIngressQueuePruneOptions,
  ChannelIngressQueueRecord,
  CreateChannelIngressQueueOptions,
} from "./ingress-queue.types.js";

class ChannelIngressClaimPolicyConflict extends Error {
  constructor(readonly settled: Promise<SqliteWorkerOperationSettlement>) {
    super("Channel ingress lane policy changed before claim commit");
  }
}

function normalizePart(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}
function idFrom(value: string | { id: string }): string {
  const id = normalizePart(typeof value === "string" ? value : value.id, "");
  if (!id) {
    throw new Error("Channel ingress event id cannot be empty");
  }
  return id;
}
function requiredRecord<TPayload, TMetadata>(
  row: ChannelIngressRow,
): ChannelIngressQueueRecord<TPayload, TMetadata> {
  const record = baseRecord<TPayload, TMetadata>(row);
  if (!record) {
    throw new Error(
      `Corrupt payload_json in channel ingress event ${row.queue_name}/${row.event_id}`,
    );
  }
  return record;
}

/** Account discovery never creates or migrates a missing database. */
export async function listChannelIngressQueueAccountIdsReadOnly(params: {
  channelId: string;
  stateDir?: string;
}): Promise<string[]> {
  const reply = await executeExistingOpenClawStateRead(
    { env: resolveChannelIngressStateEnv(params.stateDir) },
    {
      type: "channelIngress.accounts",
      input: { channelId: normalizePart(params.channelId, "unknown") },
    },
  );
  if (!reply) {
    return [];
  }
  return reply.result;
}

/** Durable ingress decisions commit in the shared-state worker; channels retain payload policy. */
export function createChannelIngressQueue<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
>(
  options: CreateChannelIngressQueueOptions,
  assertCurrent?: () => void,
): ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata> {
  assertCurrent?.();
  const channelId = normalizePart(options.channelId, "unknown");
  const accountId = normalizePart(options.accountId, "default");
  const queueName = JSON.stringify([channelId, accountId]);
  const scope = { channelId, accountId, queueName };
  const env = resolveChannelIngressStateEnv(options.stateDir);
  const readOnly = options.access === "read-only";
  const clock = options.now;
  const now = clock ?? Date.now;
  const assertQueueCurrent = (context: OpenClawStateWorkerContext) => {
    context.admission.assertCurrent();
    assertCurrent?.();
  };
  const capture = () => {
    assertCurrent?.();
    return captureOpenClawStateWorkerContext({ env });
  };
  const execute = async <Key extends keyof ChannelIngressWorkerOperations>(
    type: Key,
    input: ChannelIngressWorkerOperations[Key]["input"],
    context = capture(),
    signal?: AbortSignal,
    isClaimSelectionCurrent?: () => boolean,
    assertOperationCurrent?: () => void,
  ) => {
    const assertActive = () => {
      assertQueueCurrent(context);
      assertOperationCurrent?.();
      signal?.throwIfAborted();
    };
    const claimClock =
      type === "channelIngress.claim" ||
      type === "channelIngress.claimNext" ||
      type === "channelIngress.enqueueAndClaim"
        ? clock
        : undefined;
    const result = await runOpenClawStateWorkerOperation(
      context,
      (worker) => worker.execute({ type, input }, { signal }),
      {
        assertCurrent: assertActive,
        createAdmission:
          claimClock || isClaimSelectionCurrent
            ? (operation) => {
                const transitionClock = claimClock
                  ? new Float64Array(new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT))
                  : undefined;
                let stage: "transaction" | "commit" | "settled" = "transaction";
                return {
                  nativeLocations: [context.admission.databasePath],
                  admission: createSqliteWorkerOperationAdmission((request, grant) => {
                    if (request.stage !== stage) {
                      throw new Error("Channel ingress claim authority requested out of order");
                    }
                    assertActive();
                    if (stage === "transaction" && claimClock && transitionClock) {
                      // The grant publishes this sample after the command's FIFO wait.
                      transitionClock[0] = claimClock();
                    }
                    const selectionCurrent = isClaimSelectionCurrent?.() ?? true;
                    assertActive();
                    if (!selectionCurrent) {
                      throw new ChannelIngressClaimPolicyConflict(operation.settled);
                    }
                    if (!grant()) {
                      throw new Error("Channel ingress claim authority expired");
                    }
                    stage = stage === "transaction" ? "commit" : "settled";
                  }, transitionClock),
                };
              }
            : createSqliteWorkerWriteAdmission(assertActive, [context.admission.databasePath]),
      },
    ).finally(() => {
      if (
        type !== "channelIngress.list" &&
        type !== "channelIngress.claimSnapshot" &&
        type !== "channelIngress.staleClaims"
      ) {
        // A failed reply may follow a committed write; refresh diagnostic facts either way.
        invalidateChannelIngressHealth(context);
      }
    });
    // Mutations settle under their commit grant; prepared facts still need a live reader.
    if (
      type === "channelIngress.list" ||
      type === "channelIngress.claimSnapshot" ||
      type === "channelIngress.staleClaims"
    ) {
      assertQueueCurrent(context);
    }
    return result;
  };
  const readRows = async (input: Omit<ChannelIngressListInput, "queueName">) => {
    const context = capture();
    const rows = await runOpenClawStateWorkerOperation(
      context,
      (worker) =>
        worker.execute({ type: "channelIngress.list", input: { ...input, queueName, readOnly } }),
      { existingOnly: readOnly, assertCurrent },
    );
    assertQueueCurrent(context);
    return rows ?? [];
  };
  const mutation = (value: string | { id: string; claim?: { token: string } }, at: number) => ({
    queueName,
    id: idFrom(value),
    token: typeof value === "string" ? null : (value.claim?.token ?? null),
    now: at,
  });

  const recoverStaleClaims: ChannelIngressQueue<
    TPayload,
    TMetadata,
    TCompletedMetadata
  >["recoverStaleClaims"] = async (recoverOptions) => {
    const context = capture();
    const shouldRecover = recoverOptions?.shouldRecover;
    const shouldRecoverCorrupt = recoverOptions?.shouldRecoverCorrupt;
    const current = recoverOptions?.now ?? now();
    const cutoff = current - Math.max(0, Math.floor(recoverOptions?.staleMs ?? 0));
    const rows = await execute("channelIngress.staleClaims", { queueName, cutoff }, context);
    let recovered = 0;
    for (const row of rows) {
      assertQueueCurrent(context);
      const columns = decodeClaimColumns(row);
      const record = columns === null ? null : claimedRecord<TPayload, TMetadata>(row);
      if (record) {
        if (shouldRecover) {
          const recover = await shouldRecover(record);
          assertQueueCurrent(context);
          if (!recover) {
            continue;
          }
        }
      } else if (columns !== null) {
        if (shouldRecoverCorrupt) {
          const recover = await shouldRecoverCorrupt(corruptClaimRecord(row, columns));
          assertQueueCurrent(context);
          if (!recover) {
            continue;
          }
        } else if (shouldRecover) {
          // A payload-aware policy cannot authorize recovery of unreadable data.
          continue;
        }
      }
      assertQueueCurrent(context);
      if (await execute("channelIngress.recover", { row, cutoff, now: current }, context)) {
        recovered++;
        invalidateResumeBefore(row.received_at, row.event_id);
      }
    }
    return recovered;
  };

  // Direct scans (no candidate window) remember where a bounded claim pass
  // stopped so the next direct call resumes past a fully blocked prefix instead
  // of re-scanning it from the front. Cleared whenever a claim succeeds or the
  // scan reaches the end of the queue, so lanes that unblock are revisited. The
  // lane-policy callbacks are retained by identity so a changed policy that makes
  // an earlier row eligible invalidates the cursor instead of skipping it. The
  // pendingBeforeCursor count is the authoritative queue state at retention; it is
  // revalidated against the queue on resume so writes from other handles (which
  // cannot run this closure's invalidation) still invalidate the cursor.
  let directScanResume:
    | {
        cursor: ChannelIngressClaimCursor;
        orderBy?: "received" | "id";
        reconcileStoredLaneKey?: (
          record: ChannelIngressQueueRecord<TPayload, TMetadata>,
          storedLaneKey: string,
          derivedLaneKey: string,
        ) => boolean;
        deriveLaneKey?: (
          record: ChannelIngressQueueRecord<TPayload, TMetadata>,
        ) => string | undefined;
        blockedLaneKeys: string[];
        pendingBeforeCursor: number;
        /**
         * Fingerprint of the scan-visible pending rows strictly before the cursor
         * at retention. Revalidated against the queue on resume (with the count)
         * so offsetting writes from other handles that preserve the count still
         * invalidate the cursor.
         */
        prefixFingerprint: string;
        /** Fingerprint of the cursor row, so a resumed walk can extend the prefix. */
        cursorRowFingerprint: string;
      }
    | undefined;

  // A retained direct-scan cursor is only valid while no pending row exists
  // before it. Any write that adds a pending row sorting before the cursor
  // (an explicit earlier receivedAt, a recovered/released claim, a resubmit)
  // must invalidate the cursor so the next direct call rescans from the front
  // instead of skipping that earlier row.
  const invalidateResumeBefore = (receivedAt: number, eventId: string) => {
    const resume = directScanResume;
    if (!resume) {
      return;
    }
    const before =
      resume.orderBy === "id"
        ? eventId < resume.cursor.eventId
        : receivedAt < resume.cursor.receivedAt ||
          (receivedAt === resume.cursor.receivedAt && eventId < resume.cursor.eventId);
    if (before) {
      directScanResume = undefined;
    }
  };

  const claimNext: ChannelIngressQueue<
    TPayload,
    TMetadata,
    TCompletedMetadata
  >["claimNext"] = async (claimOptions) => {
    const context = capture();
    const deriveLaneKey = claimOptions?.deriveLaneKey;
    const reconcileStoredLaneKey = claimOptions?.reconcileStoredLaneKey;
    const ownerId = normalizePart(claimOptions?.ownerId, `${process.pid}`);
    if (claimOptions?.staleMs !== undefined) {
      await recoverStaleClaims({ staleMs: claimOptions.staleMs });
    }
    const candidateIds =
      claimOptions?.candidateIds === undefined
        ? undefined
        : [...claimOptions.candidateIds].map((id) => id.trim()).filter(Boolean);
    if (candidateIds?.length === 0) {
      return null;
    }
    const requestBase: ChannelIngressClaimRequest = {
      queueName,
      candidateIds,
      blockedLaneKeys: [...(claimOptions?.blockedLaneKeys ?? [])]
        .map((key) => key.trim())
        .filter(Boolean),
      reconcileStoredLaneKey: Boolean(reconcileStoredLaneKey),
      orderBy: claimOptions?.orderBy,
      scanLimit: claimOptions?.scanLimit,
    };
    const resolveLane = (row: ChannelIngressRow): string | undefined => {
      if (row.status === "claimed" && row.lane_key && !reconcileStoredLaneKey) {
        return row.lane_key;
      }
      const record = baseRecord<TPayload, TMetadata>(row);
      if (!record) {
        return row.lane_key ?? undefined;
      }
      const stored = record.laneKey;
      if (stored === undefined) {
        return deriveLaneKey?.(record);
      }
      if (!deriveLaneKey || !reconcileStoredLaneKey) {
        return stored;
      }
      const derived = deriveLaneKey(record);
      return derived && derived !== stored && reconcileStoredLaneKey(record, stored, derived)
        ? derived
        : stored;
    };
    // A fully blocked snapshot holds only the first scanLimit + repair rows; page
    // forward with a keyset cursor so a free lane beyond a blocked prefix stays
    // reachable, bounded by the claim scan budget for stop responsiveness. When
    // the budget runs out, the cursor is retained so the next direct call resumes
    // past the blocked prefix instead of restarting at the queue front.
    const directScan = candidateIds === undefined;
    let claimAfter: ChannelIngressClaimCursor | undefined;
    let claimPages = 0;
    // Scan-visible pending rows walked this call; the retained cursor records the
    // count strictly before its position so a later resume can revalidate it.
    let scannedPendingRows = 0;
    // The authoritative count the queue must still show strictly before the page
    // cursor; a mismatch means a write from any handle changed those rows, so the
    // keyset is dropped and the scan restarts from the front.
    let expectedPendingBeforeCursor: number | undefined;
    // The authoritative fingerprint of the same prefix; a mismatch means a write
    // replaced rows before the cursor while preserving the count, so the keyset
    // is dropped too.
    let expectedPendingBeforeCursorFingerprint: string | undefined;
    // Fingerprint of the row that became claimAfter, needed to extend the prefix
    // fingerprint across pages (the next prefix includes the cursor row).
    let lastCursorRowFingerprint: string | undefined;
    // Set on a resumed derived-lane scan: the first paged request returns the
    // materialized prefix rows so their lanes can be re-evaluated under the
    // current callback policy (identity alone cannot prove it unchanged).
    let revalidatePrefixPolicy = false;
    const blockedLaneKeySet = new Set(requestBase.blockedLaneKeys);
    if (directScan && directScanResume) {
      const resume = directScanResume;
      const inputsMatch =
        resume.orderBy === requestBase.orderBy &&
        resume.reconcileStoredLaneKey === reconcileStoredLaneKey &&
        resume.deriveLaneKey === deriveLaneKey &&
        resume.blockedLaneKeys.length === requestBase.blockedLaneKeys.length &&
        resume.blockedLaneKeys.every((key, index) => key === requestBase.blockedLaneKeys[index]);
      if (inputsMatch) {
        claimAfter = resume.cursor;
        expectedPendingBeforeCursor = resume.pendingBeforeCursor;
        expectedPendingBeforeCursorFingerprint = resume.prefixFingerprint;
        lastCursorRowFingerprint = resume.cursorRowFingerprint;
        revalidatePrefixPolicy = Boolean(deriveLaneKey);
        // The resume page skips rows before the cursor; seed the walk with the
        // count including the cursor row so a re-retained cursor still records the
        // rows strictly before it (scannedPendingRows - 1) without double-subtracting.
        scannedPendingRows = resume.pendingBeforeCursor + 1;
      }
      directScanResume = undefined;
    }
    while (true) {
      const request: ChannelIngressClaimRequest =
        claimAfter && expectedPendingBeforeCursor !== undefined
          ? {
              ...requestBase,
              claimAfter,
              expectedPendingBeforeCursor,
              ...(expectedPendingBeforeCursorFingerprint === undefined
                ? {}
                : { expectedPendingBeforeCursorFingerprint }),
              ...(revalidatePrefixPolicy ? { includePrefixRows: true } : {}),
            }
          : claimAfter
            ? { ...requestBase, claimAfter }
            : requestBase;
      const snapshot = await execute("channelIngress.claimSnapshot", request, context);
      if (expectedPendingBeforeCursor !== undefined) {
        // Authoritative revalidation: the queue counts and fingerprints the
        // scan-visible pending rows before the cursor in this same read. A
        // mismatch means a write from any handle inserted, removed, or replaced a
        // row before the cursor, so the retained or in-flight progress is stale
        // and the keyset must be dropped to rescan from the front instead of
        // skipping that earlier row. The cursor row itself is checked too: the
        // strict-before prefix cannot observe an equal-position replacement of it.
        const prefixStale =
          snapshot.pendingBeforeCursor !== expectedPendingBeforeCursor ||
          (expectedPendingBeforeCursorFingerprint !== undefined &&
            snapshot.pendingBeforeCursorFingerprint !== expectedPendingBeforeCursorFingerprint) ||
          snapshot.cursorRowFingerprint !== lastCursorRowFingerprint;
        // Callback identity cannot prove an unchanged captured policy, so a
        // resumed derived-lane scan re-evaluates every skipped row — the
        // strict-before prefix rows and the cursor row itself — under the
        // current callback. A row that now resolves outside the blocked set
        // was made eligible by the policy change; the keyset must not skip it.
        const policyShifted =
          !prefixStale &&
          revalidatePrefixPolicy &&
          [
            ...(snapshot.prefixRows ?? []),
            ...(snapshot.cursorRow ? [snapshot.cursorRow] : []),
          ].some((row) => {
            if (!baseRecord(row)) {
              return false;
            }
            const lane = resolveLane(row);
            return lane === undefined || !blockedLaneKeySet.has(lane);
          });
        revalidatePrefixPolicy = false;
        if (prefixStale || policyShifted) {
          claimAfter = undefined;
          expectedPendingBeforeCursor = undefined;
          expectedPendingBeforeCursorFingerprint = undefined;
          scannedPendingRows = 0;
          continue;
        }
        expectedPendingBeforeCursor = undefined;
        expectedPendingBeforeCursorFingerprint = undefined;
      }
      scannedPendingRows += snapshot.pending.length;
      // Fingerprint of the scan-visible pending rows strictly before the page's
      // last row: the validated current prefix, the previous cursor row, and this
      // page's walked rows except the cursor row. XOR-composed so the next page or
      // a retained resume can be revalidated against the authoritative queue state.
      const prefixFingerprintAfterPage = (
        page: ChannelIngressRow[],
        previousCursorFingerprint: string | undefined,
      ): string => {
        const pageFingerprint = xorChannelIngressPrefixFingerprints(
          ...page.slice(0, -1).map((row) => channelIngressPrefixRowFingerprint(row)),
        );
        return snapshot.pendingBeforeCursorFingerprint === undefined
          ? pageFingerprint
          : xorChannelIngressPrefixFingerprints(
              snapshot.pendingBeforeCursorFingerprint,
              previousCursorFingerprint ?? "",
              pageFingerprint,
            );
      };
      // Native fingerprinting owns row freshness; retain only the lane observations to recheck.
      const preparedLanes: Array<{ row: ChannelIngressRow; laneKey: string | undefined }> = [];
      const selection = selectChannelIngressClaim(
        snapshot,
        request,
        deriveLaneKey
          ? (row) => {
              const laneKey = resolveLane(row);
              preparedLanes.push({ row, laneKey });
              return laneKey;
            }
          : resolveLane,
      );
      try {
        const result = await execute(
          "channelIngress.claimNext",
          {
            request,
            snapshot,
            selection,
            ownerId,
            customClock: clock ? true : undefined,
          },
          context,
          undefined,
          deriveLaneKey
            ? () => preparedLanes.every(({ row, laneKey }) => resolveLane(row) === laneKey)
            : undefined,
        );
        if (result.kind === "conflict") {
          // The queue changed under the page; a write may sit behind the in-flight
          // cursor, so rescan from the front instead of trusting the keyset.
          if (directScan) {
            claimAfter = undefined;
            expectedPendingBeforeCursor = undefined;
            expectedPendingBeforeCursorFingerprint = undefined;
            scannedPendingRows = 0;
          }
          continue;
        }
        if (result.row) {
          directScanResume = undefined;
          return claimedRecord<TPayload, TMetadata>(result.row);
        }
        if (selection.more && claimPages < CHANNEL_INGRESS_CLAIM_SCAN_PAGE_BUDGET) {
          const last = snapshot.pending.at(-1);
          if (!last) {
            return null;
          }
          if (directScan) {
            // The next page starts after last; it is only valid while the queue
            // still holds exactly the walked rows (minus the cursor row) before it,
            // with the same membership fingerprint.
            expectedPendingBeforeCursor = scannedPendingRows - 1;
            expectedPendingBeforeCursorFingerprint = prefixFingerprintAfterPage(
              snapshot.pending,
              lastCursorRowFingerprint,
            );
          }
          claimAfter = { receivedAt: last.received_at, eventId: last.event_id };
          lastCursorRowFingerprint = channelIngressPrefixRowFingerprint(last);
          claimPages += 1;
          continue;
        }
        if (directScan) {
          const last = snapshot.pending.at(-1);
          if (selection.more && last) {
            // The blocked prefix continues beyond this bounded pass; preserve
            // progress so the next direct call resumes past it. The scanned count
            // minus the cursor row itself and the prefix fingerprint are the
            // authoritative state the resume revalidates against the queue.
            directScanResume = {
              cursor: { receivedAt: last.received_at, eventId: last.event_id },
              orderBy: requestBase.orderBy,
              reconcileStoredLaneKey,
              deriveLaneKey,
              blockedLaneKeys: requestBase.blockedLaneKeys,
              pendingBeforeCursor: scannedPendingRows - 1,
              prefixFingerprint: prefixFingerprintAfterPage(
                snapshot.pending,
                lastCursorRowFingerprint,
              ),
              cursorRowFingerprint: channelIngressPrefixRowFingerprint(last),
            };
          } else {
            // The scan reached the end of the queue; wrap so lanes that unblock
            // or rows enqueued before the cursor are revisited on the next call.
            directScanResume = undefined;
          }
        }
        return null;
      } catch (error) {
        // Only our refused grant plus native rollback settlement permits another claim.
        if (
          error instanceof ChannelIngressClaimPolicyConflict &&
          (await error.settled).kind === "completed"
        ) {
          if (directScan) {
            claimAfter = undefined;
            expectedPendingBeforeCursor = undefined;
            expectedPendingBeforeCursorFingerprint = undefined;
            scannedPendingRows = 0;
          }
          continue;
        }
        throw error;
      }
    }
  };

  type Queue = ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>;
  const enqueueResult = (
    result: ChannelIngressWorkerOperations["channelIngress.enqueue"]["output"][number],
  ): Awaited<ReturnType<Queue["enqueue"]>> => {
    const row = result.row;
    if (result.accepted) {
      // A new pending row before the retained cursor would be skipped by the
      // keyset resume; drop the cursor so the earlier row stays reachable.
      invalidateResumeBefore(receivedAt, eventId);
      return {
        kind: "accepted",
        duplicate: false,
        record: requiredRecord<TPayload, TMetadata>(row),
      };
    }
    if (row.status === "completed") {
      return {
        kind: "completed",
        duplicate: true,
        record: completedRecord<TCompletedMetadata>(row),
      };
    }
    if (row.status === "failed") {
      return { kind: "failed", duplicate: true, record: failedRecord<TPayload, TMetadata>(row) };
    }
    if (row.status === "claimed") {
      const record = claimedRecord<TPayload, TMetadata>(row);
      if (!record) {
        throw new Error(`Corrupt claimed channel ingress event ${queueName}/${row.event_id}`);
      }
      return { kind: "claimed", duplicate: true, record };
    }
    return { kind: "pending", duplicate: true, record: requiredRecord<TPayload, TMetadata>(row) };
  };
  const serializeEvent = (event: Parameters<NonNullable<Queue["enqueueBatch"]>>[0][number]) => ({
    id: idFrom(event.id),
    payloadJson: JSON.stringify(event.payload),
    metadataJson: event.metadata === undefined ? null : JSON.stringify(event.metadata),
    receivedAt: event.receivedAt ?? now(),
    laneKey: event.laneKey,
  });
  const enqueueBatch = async (
    events: Parameters<NonNullable<Queue["enqueueBatch"]>>[0],
    assertOperationCurrent?: () => void,
  ): Promise<Array<Awaited<ReturnType<Queue["enqueue"]>>>> => {
    assertOperationCurrent?.();
    if (events.length === 0) {
      return [];
    }
    const result = await execute(
      "channelIngress.enqueue",
      {
        ...scope,
        events: events.map(serializeEvent),
        now: now(),
      },
      capture(),
      undefined,
      undefined,
      assertOperationCurrent,
    );
    return result.map(enqueueResult);
  };
  const enqueue = async (
    id: string,
    payload: TPayload,
    enqueueOptions?: Parameters<Queue["enqueue"]>[2],
    assertOperationCurrent?: () => void,
  ): ReturnType<Queue["enqueue"]> => {
    const [result] = await enqueueBatch(
      [{ id, payload, ...enqueueOptions }],
      assertOperationCurrent,
    );
    return result!;
  };
  return {
    enqueue,
    enqueueBatch,
    enqueueBatchAuthorized: (events, authorizedOptions) => {
      if (typeof authorizedOptions.assertCurrent !== "function") {
        return Promise.reject(
          new TypeError("Authorized ingress requires a current-owner assertion"),
        );
      }
      return enqueueBatch(events, authorizedOptions.assertCurrent);
    },
    async enqueueAndClaim(id, payload, enqueueOptions) {
      const [entry] = await execute("channelIngress.enqueueAndClaim", {
        ...scope,
        events: [serializeEvent({ id, payload, ...enqueueOptions })],
        now: now(),
        idleClaimOwnerId: enqueueOptions.ownerId,
        customClock: clock ? true : undefined,
      });
      const result = enqueueResult(entry!);
      return {
        result,
        freshClaim:
          result.kind === "accepted" && entry!.freshClaim
            ? { ...result.record, claim: entry!.freshClaim }
            : undefined,
      };
    },
    enqueueAuthorized: (id, payload, authorizedOptions) => {
      if (typeof authorizedOptions.assertCurrent !== "function") {
        return Promise.reject(
          new TypeError("Authorized ingress requires a current-owner assertion"),
        );
      }
      const { assertCurrent: assertOperationCurrent, ...enqueueOptions } = authorizedOptions;
      return enqueue(id, payload, enqueueOptions, assertOperationCurrent);
    },
    async listPending(listOptions) {
      return (await readRows({ status: "pending", ...listOptions })).map((row) =>
        requiredRecord<TPayload, TMetadata>(row),
      );
    },
    async listClaims() {
      return (await readRows({ status: "claimed" }))
        .map((row) => claimedRecord<TPayload, TMetadata>(row))
        .filter((row): row is ChannelIngressQueueClaim<TPayload, TMetadata> => row !== null);
    },
    async listUnsettled(listOptions) {
      const rows = await readRows({ status: "unsettled", ...listOptions });
      const pending: Array<ChannelIngressQueueRecord<TPayload, TMetadata>> = [];
      const claims: Array<ChannelIngressQueueClaim<TPayload, TMetadata>> = [];
      for (const row of rows) {
        if (row.status === "claimed") {
          const claim = claimedRecord<TPayload, TMetadata>(row);
          if (claim) {
            claims.push(claim);
          }
        } else {
          const record = baseRecord<TPayload, TMetadata>(row);
          if (record) {
            pending.push(record);
          }
        }
      }
      return { pending, claims };
    },
    async listFailed(listOptions) {
      return (await readRows({ status: "failed", ...listOptions })).map((row) =>
        failedRecord<TPayload, TMetadata>(row),
      );
    },
    claimNext,
    async claim(id, claimOptions) {
      const row = await execute("channelIngress.claim", {
        queueName,
        id: idFrom(id),
        ownerId: normalizePart(claimOptions?.ownerId, `${process.pid}`),
        laneKey: claimOptions?.laneKey,
        customClock: clock ? true : undefined,
      });
      return row ? claimedRecord<TPayload, TMetadata>(row) : null;
    },
    refreshClaim: async (claim, refreshOptions) =>
      await execute(
        "channelIngress.refresh",
        mutation(claim, refreshOptions?.refreshedAt ?? now()),
      ),
    complete: async (value, completeOptions) =>
      await execute("channelIngress.complete", {
        ...scope,
        ...mutation(value, completeOptions?.completedAt ?? now()),
        metadataJson:
          completeOptions?.metadata === undefined ? null : JSON.stringify(completeOptions.metadata),
      }),
    release: async (value, releaseOptions) => {
      const released = await execute("channelIngress.release", {
        ...mutation(value, releaseOptions?.releasedAt ?? now()),
        recordAttempt: releaseOptions?.recordAttempt,
        lastError: releaseOptions?.lastError,
      });
      if (released && typeof value !== "string" && "receivedAt" in value) {
        const releasedAt =
          // SAFETY: the `in` guard proved the caller passed a full claim with receivedAt.
          (value as ChannelIngressQueueClaim<TPayload, TMetadata> & { receivedAt: number })
            .receivedAt;
        invalidateResumeBefore(releasedAt, value.id);
      }
      return released;
    },
    fail: async (value, failOptions) =>
      await execute("channelIngress.fail", {
        ...mutation(value, failOptions.failedAt ?? now()),
        reason: failOptions.reason,
        message: failOptions.message,
      }),
    async resubmit(id, resubmitOptions) {
      const result = await execute("channelIngress.resubmit", {
        queueName,
        id: idFrom(id),
        now: resubmitOptions?.resubmittedAt ?? now(),
      });
      switch (result.kind) {
        case "not-found":
        case "active":
          return result;
        case "completed":
          return { kind: result.kind, record: completedRecord<TCompletedMetadata>(result.row) };
        case "unrecoverable":
          return { kind: result.kind, record: failedRecord<TPayload, TMetadata>(result.row) };
        case "resubmitted":
          invalidateResumeBefore(result.row.received_at, result.row.event_id);
          return {
            kind: result.kind,
            record: requiredRecord<TPayload, TMetadata>(result.row),
            previous: failedRecord<TPayload, TMetadata>(result.previous),
          };
      }
      return result satisfies never;
    },
    delete: async (value) => await execute("channelIngress.delete", mutation(value, now())),
    recoverStaleClaims,
    purge: async (purgeOptions) =>
      await execute("channelIngress.purge", { queueName }, capture(), purgeOptions?.signal),
    async prune(pruneOptions) {
      assertCurrent?.();
      if (
        !pruneOptions ||
        (pruneOptions.pendingTtlMs === undefined &&
          pruneOptions.completedTtlMs === undefined &&
          pruneOptions.failedTtlMs === undefined &&
          pruneOptions.pendingMaxEntries === undefined &&
          pruneOptions.completedMaxEntries === undefined &&
          pruneOptions.failedMaxEntries === undefined)
      ) {
        return 0;
      }
      return execute("channelIngress.prune", {
        queueName,
        options: {
          ...pruneOptions,
          protectIds:
            pruneOptions.protectIds === undefined ? undefined : [...pruneOptions.protectIds],
        },
        now: pruneOptions.now ?? now(),
      });
    },
  };
}
