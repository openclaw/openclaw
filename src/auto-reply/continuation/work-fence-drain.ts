/**
 * The fence drain (RFC docs/design/continue-work-signal-v2.md §5.4.2, "At most once through a
 * crash"). A build without the turn-start fence strips `turnStart` on decode and re-drives a fenced,
 * undelivered wake, so a seat must hold none before such a build starts. The count reads the stopped
 * store without writing; the drain ends each such wake as recovery does and settles its one notice
 * into the delivery queue. The operator surface (`openclaw continuations`) runs both only while no
 * Gateway owns the state, so no turn is in flight.
 */
import { listContinuationRecordsReadOnly } from "./custody/custody-store.js";
import {
  interruptUndeliveredTurnFences,
  listPendingTerminalNoticeWork,
  owesInterruptedTurnNotice,
  readUndeliveredTurnFence,
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
  const owed = records.filter(owesInterruptedTurnNotice).map((record) => record.recordId);
  return {
    fencedUndelivered: fenced.length,
    records: fenced,
    owedInterruptNotices: owed.length,
    owedNoticeRecordIds: owed,
  };
}

/**
 * Interrupt every fenced, undelivered wake, then settle every interrupted-turn notice still owed:
 * this run's, and any an earlier pass left owed. Never runs a turn. A second run changes nothing.
 */
export async function drainUndeliveredTurnFences(): Promise<ContinuationFenceDrainReceipt> {
  const interruptedNow = new Set(
    (await interruptUndeliveredTurnFences()).flatMap((work) => work.flowId ?? []),
  );
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
