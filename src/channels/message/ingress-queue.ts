import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { resolveChannelIngressStateEnv } from "./ingress-queue-client.js";
import {
  baseRecord,
  claimedRecord,
  completedRecord,
  corruptClaimRecord,
  decodeClaimColumns,
  failedRecord,
  selectChannelIngressClaim,
} from "./ingress-queue.codec.js";
import type {
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
function tokenFrom(value: string | { id: string; claim?: { token: string } }): string | null {
  return typeof value === "string" ? null : (value.claim?.token ?? null);
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
  if (!reply.ok || reply.type !== "channelIngress.accounts") {
    throw new Error("Channel ingress account reader returned an unexpected result");
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
  ) => {
    const assertActive = () => {
      assertQueueCurrent(context);
      signal?.throwIfAborted();
    };
    const claimClock =
      type === "channelIngress.claim" || type === "channelIngress.claimNext" ? clock : undefined;
    const result = await runOpenClawStateWorkerOperation(
      context,
      (worker) => worker.execute({ type, input }, { signal }),
      {
        assertCurrent: assertActive,
        requireStateLifecycle: true,
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
    );
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
      { existingOnly: readOnly, assertCurrent, requireStateLifecycle: true },
    );
    assertQueueCurrent(context);
    return rows ?? [];
  };
  const mutation = (value: string | { id: string; claim?: { token: string } }, at: number) => ({
    queueName,
    id: idFrom(value),
    token: tokenFrom(value),
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
      }
    }
    return recovered;
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
    const request: ChannelIngressClaimRequest = {
      queueName,
      candidateIds,
      blockedLaneKeys: [...(claimOptions?.blockedLaneKeys ?? [])]
        .map((key) => key.trim())
        .filter(Boolean),
      deriveLaneKey: Boolean(deriveLaneKey),
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
    while (true) {
      const snapshot = await execute("channelIngress.claimSnapshot", request, context);
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
          continue;
        }
        return result.row ? claimedRecord<TPayload, TMetadata>(result.row) : null;
      } catch (error) {
        // Only our refused grant plus native rollback settlement permits another claim.
        if (
          error instanceof ChannelIngressClaimPolicyConflict &&
          (await error.settled).kind === "completed"
        ) {
          continue;
        }
        throw error;
      }
    }
  };

  return {
    async enqueue(id, payload, enqueueOptions) {
      const eventId = idFrom(id);
      const receivedAt = enqueueOptions?.receivedAt ?? now();
      const result = await execute("channelIngress.enqueue", {
        ...scope,
        id: eventId,
        payloadJson: JSON.stringify(payload),
        metadataJson:
          enqueueOptions?.metadata === undefined ? null : JSON.stringify(enqueueOptions.metadata),
        receivedAt,
        now: now(),
        laneKey: enqueueOptions?.laneKey,
      });
      const row = result.row;
      if (result.accepted) {
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
          throw new Error(`Corrupt claimed channel ingress event ${queueName}/${eventId}`);
        }
        return { kind: "claimed", duplicate: true, record };
      }
      return { kind: "pending", duplicate: true, record: requiredRecord<TPayload, TMetadata>(row) };
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
    release: async (value, releaseOptions) =>
      await execute("channelIngress.release", {
        ...mutation(value, releaseOptions?.releasedAt ?? now()),
        recordAttempt: releaseOptions?.recordAttempt,
        lastError: releaseOptions?.lastError,
      }),
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
