/**
 * The fence drain (RFC docs/design/continue-work-signal-v2.md §5.4.2, "Moving a seat below the
 * fence"). A build without the turn-start fence strips `turnStart` on decode and re-drives a fenced,
 * undelivered wake, so a seat must hold none before such a build starts. The count reads the stopped
 * store without writing; the drain ends each such wake as recovery does and settles its one notice
 * into the delivery queue. The operator surface (`openclaw continuations`) runs both only while no
 * Gateway owns the state, so no turn is in flight.
 */
import {
  listContinuationRecords,
  listContinuationRecordsReadOnly,
} from "./custody/custody-store.js";
import type { ContinuationRecord } from "./custody/custody-store.types.js";
import {
  decodeWorkState,
  isContinuationWorkFlow,
  type PendingWorkState,
} from "./work-flow-state.js";
import {
  interruptStartedWorkRecord,
  listPendingTerminalNoticeWork,
  toNoticeWork,
} from "./work-store.js";
import { settlePendingTerminalNotice } from "./work-terminal-notice.js";

export type ContinuationFenceStatus = {
  /** Live wakes a build without the fence would re-drive; a seat may move to one only at 0. */
  fencedUndelivered: number;
  records: Array<{
    recordId: string;
    ownerSessionKey: string;
    status: string;
    runId: string;
    startedAt: number;
  }>;
  /**
   * Interrupted wakes whose notice has not reached the delivery queue. A build without the fence
   * words such a notice as retry-exhausted; the drain settles it with the interrupted text.
   */
  owedInterruptNotices: number;
  owedNoticeRecordIds: string[];
};

export type ContinuationFenceDrainReceipt = {
  /** Wakes this run ended as interrupted. */
  interrupted: number;
  /** Interrupted-turn notices this run settled into the delivery queue, one row per record. */
  noticesSettled: number;
  records: Array<{
    recordId: string;
    ownerSessionKey: string;
    status: string;
    failureReason?: string;
    interruptedNow: boolean;
    noticeDeliveryId: string;
    noticeDeliveryStatus: string;
  }>;
};

/**
 * The fence of a live wake whose turn started but whose delivery was never confirmed: recovery
 * interrupts it, never drives it. A cancel-fenced record is not one, since no build drives it. An
 * undecodable record is not one either: this build rejects it unrun.
 */
function readUndeliveredTurnFence(
  record: ContinuationRecord,
): PendingWorkState["turnStart"] | undefined {
  if (
    !isContinuationWorkFlow(record) ||
    (record.status !== "queued" && record.status !== "running") ||
    record.cancelRequestedAt !== undefined
  ) {
    return undefined;
  }
  const state = decodeWorkState(record);
  return state && !state.succeeded ? state.turnStart : undefined;
}

/** Read-only: lists the stopped store through a snapshot, never a writer. */
export async function readContinuationFenceStatus(
  env: NodeJS.ProcessEnv,
): Promise<ContinuationFenceStatus> {
  const records = await listContinuationRecordsReadOnly(
    { kinds: ["work"], statuses: ["queued", "running", "failed"] },
    { env },
  );
  const fenced = records.flatMap((record) => {
    const turnStart = readUndeliveredTurnFence(record);
    return turnStart
      ? [
          {
            recordId: record.recordId,
            ownerSessionKey: record.ownerSessionKey,
            status: record.status,
            runId: turnStart.runId,
            startedAt: turnStart.startedAt,
          },
        ]
      : [];
  });
  const owed = records
    .filter((record) => toNoticeWork(record)?.terminalNoticePending === "turn-interrupted")
    .map((record) => record.recordId);
  return {
    fencedUndelivered: fenced.length,
    records: fenced,
    owedInterruptNotices: owed.length,
    owedNoticeRecordIds: owed,
  };
}

/**
 * Offline only: with no Gateway running no turn is in flight, so every fenced, undelivered wake ends
 * now exactly as recovery ends it, owing its one notice in the same CAS. Then every interrupted-turn
 * notice still owed is settled: this run's, and any an earlier pass left owed. It never claims,
 * requeues or drives a record, and a second run changes nothing.
 */
export async function drainUndeliveredTurnFences(): Promise<ContinuationFenceDrainReceipt> {
  const interruptedNow = new Set<string>();
  for (const record of await listContinuationRecords({
    kinds: ["work"],
    statuses: ["queued", "running"],
  })) {
    if (readUndeliveredTurnFence(record) && (await interruptStartedWorkRecord(record))) {
      interruptedNow.add(record.recordId);
    }
  }
  const records: ContinuationFenceDrainReceipt["records"] = [];
  for (const owed of await listPendingTerminalNoticeWork()) {
    if (owed.terminalNoticePending !== "turn-interrupted" || !owed.flowId) {
      continue;
    }
    const settled = await settlePendingTerminalNotice(owed.flowId);
    if (!settled) {
      continue;
    }
    records.push({
      recordId: settled.record.recordId,
      ownerSessionKey: settled.record.ownerSessionKey,
      status: settled.record.status,
      ...(settled.record.failureReason ? { failureReason: settled.record.failureReason } : {}),
      interruptedNow: interruptedNow.has(settled.record.recordId),
      noticeDeliveryId: settled.entryId,
      noticeDeliveryStatus: settled.entryStatus,
    });
  }
  return { interrupted: interruptedNow.size, noticesSettled: records.length, records };
}
