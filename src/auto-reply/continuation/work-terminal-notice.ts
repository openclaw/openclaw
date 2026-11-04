/**
 * Durable agent-visible outcome for terminally failed continuation work.
 *
 * `enqueueSystemEvent` is an explicitly non-durable in-process queue, so it
 * cannot on its own satisfy the product invariant that every action ends in a
 * visible outcome: a Gateway restart between the terminal write and the next
 * prompt drain would silently discard the notice, and terminal records are
 * invisible to normal continuation recovery.
 *
 * The obligation therefore moves through two owners (RFC
 * docs/design/continue-work-signal-v2.md §5.4.2):
 *
 *   1. `work-store` persists `terminalNoticePending` in the SAME CAS that fails
 *      the record. A crash here leaves the obligation readable in custody.
 *   2. this module inserts the notice's session-delivery row and clears the
 *      obligation in ONE custody transaction, under a record-stable
 *      idempotency key, so the notice is neither lost nor enqueued twice.
 *
 * The delivery queue owns delivery from that point. The in-memory event is
 * only the fast path; it carries the durable row's ack id, and that row is
 * acknowledged only after the prompt actually consumes it.
 */

import { prepareSessionDeliveryEnqueue } from "../../infra/session-delivery-queue-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import {
  defaultContinuationNoticeSurfaceDeps,
  scheduleCommittedContinuationNotice,
  surfaceDurableContinuationNotice,
  type ContinuationNoticeSurfaceDeps,
} from "./continuation-notice-surface.js";
import { settleContinuationNotice } from "./custody/custody-store.js";
// Continuation (karmaterminal): detached re-entries re-admit on the current plugin generation.
import { runOnCurrentPluginGeneration } from "./detached-generation.js";
import type { PendingContinuationWork } from "./work-flow-state.js";
import { listPendingTerminalNoticeWork, readPendingTerminalNoticeWork } from "./work-store.js";

const log = createSubsystemLogger("continuation/work-terminal-notice");

/**
 * Operator-facing detail (provider payloads, URLs, credentials) never reaches
 * this string: it is injected into the model's context. The raw driver error
 * stays on the durable record's failure reason and in the terminal error log.
 */
export const CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE =
  "[system:continuation-warning] continue_work permanently failed after exhausting its retries; the scheduled follow-up turn will not run. Reissue continue_work if the work is still needed.";

const CONTINUATION_WORK_TURN_INTERRUPTED_NOTICE_TAG = "[continuation:work-turn-interrupted]";

/**
 * The notice a record owes. A wake whose turn started but whose delivery was never confirmed is
 * interrupted, never run again (RFC §5.4.2); its notice names the record and the run, in the
 * delegate interrupted-spawn notice's shape, so the agent can check what the run did.
 */
function terminalNoticeText(work: PendingContinuationWork): string {
  if (work.terminalNoticePending !== "turn-interrupted") {
    return CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE;
  }
  const run = work.turnStart
    ? ` as run ${work.turnStart.runId} at ${new Date(work.turnStart.startedAt).toISOString()}`
    : "";
  return [
    CONTINUATION_WORK_TURN_INTERRUPTED_NOTICE_TAG,
    `continue_work record ${work.flowId} started its turn${run}, and that turn's completion was never confirmed.`,
    "Its effects may already have happened, so it was not run again.",
    "Check what that run did, then reissue continue_work if the work is still needed.",
  ].join("\n");
}

/** Record-stable so a replayed handoff reuses one durable row instead of adding another. */
function continuationWorkTerminalNoticeIdempotencyKey(recordId: string): string {
  return `continuation-work-terminal-notice:${recordId}`;
}

type ContinuationWorkTerminalNoticeDeps = ContinuationNoticeSurfaceDeps & {
  settleContinuationNotice: typeof settleContinuationNotice;
  queueContext?: OpenClawStateWorkerContext;
  stateDir?: string;
};

const defaultDeps: ContinuationWorkTerminalNoticeDeps = {
  ...defaultContinuationNoticeSurfaceDeps,
  settleContinuationNotice,
};

function prepareTerminalNoticeEntry(
  flowId: string,
  sessionKey: string,
  text: string,
  now = Date.now(),
) {
  return prepareSessionDeliveryEnqueue(
    {
      kind: "systemEvent",
      sessionKey,
      text,
      idempotencyKey: continuationWorkTerminalNoticeIdempotencyKey(flowId),
      // The row must outlive the in-memory event and survive until the prompt
      // adopts it; see the delivery path's plain-event deferral.
      awaitPromptAdoption: true,
    },
    now,
  );
}

/**
 * Move one owed notice into its one durable session-delivery row and release the obligation, in one
 * custody transaction. The row then owns delivery, including through a restart: the Gateway's
 * startup delivery recovery replays it with the text written here. Undefined when nothing is owed.
 */
export async function settlePendingTerminalNotice(
  flowId: string,
  deps: Pick<ContinuationWorkTerminalNoticeDeps, "settleContinuationNotice"> = defaultDeps,
) {
  // Re-read under a current revision: the caller that terminalized the record
  // holds the pre-CAS revision, and another drain may already have settled it.
  const pending = await readPendingTerminalNoticeWork(flowId);
  if (!pending?.flowId || pending.expectedRevision === undefined) {
    return undefined;
  }
  const now = Date.now();
  const text = terminalNoticeText(pending);
  const { bound } = prepareTerminalNoticeEntry(pending.flowId, pending.sessionKey, text, now);
  const settled = await deps.settleContinuationNotice({
    recordId: pending.flowId,
    ownerSessionKey: pending.sessionKey,
    expectedRevision: pending.expectedRevision,
    notice: bound,
    now,
  });
  // Any other outcome: another drain settled it first; its row is the only one.
  return settled.outcome === "settled"
    ? {
        pending,
        text,
        record: settled.record,
        entryId: settled.entryId,
        entryStatus: settled.entryStatus,
      }
    : undefined;
}

/** Hand one pending terminal notice to the durable queue and release the obligation. */
export async function deliverPendingTerminalNotice(
  work: PendingContinuationWork,
  deps: ContinuationWorkTerminalNoticeDeps = defaultDeps,
): Promise<boolean> {
  if (!work.flowId) {
    return false;
  }
  const settled = await settlePendingTerminalNotice(work.flowId, deps);
  if (!settled) {
    return false;
  }
  const { pending, text } = settled;
  const surfaced = await surfaceDurableContinuationNotice(
    {
      entryId: settled.entryId,
      entryStatus: settled.entryStatus,
      sessionKey: pending.sessionKey,
      text,
      reason: "continuation-terminal-notice",
      ...(deps.queueContext ? { queueContext: deps.queueContext } : {}),
      ...(deps.stateDir ? { stateDir: deps.stateDir } : {}),
    },
    deps,
  );
  log.info(
    surfaced
      ? `[continuation:work-terminal-notice-handed-off] flowId=${pending.flowId} session=${pending.sessionKey} deliveryId=${settled.entryId}`
      : `[continuation:work-terminal-notice-already-settled] flowId=${pending.flowId} session=${pending.sessionKey} deliveryId=${settled.entryId}`,
  );
  return surfaced;
}

/** Hard bound on live retries of a failed durable handoff. */
export const TERMINAL_NOTICE_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000] as const;

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Test-only: cancel armed retry timers. */
export function resetTerminalNoticeRetriesForTests(): void {
  for (const timer of retryTimers.values()) {
    clearTimeout(timer);
  }
  retryTimers.clear();
}

/**
 * Arm a bounded live retry for a handoff that failed before reaching the queue.
 *
 * An obligation without a queue row is invisible to the delivery scheduler, so
 * without this it would wait for the next Gateway restart. Retries are
 * hard-capped; a failure never clears the obligation, so a restart remains the
 * final backstop.
 */
function armTerminalNoticeRetry(
  work: PendingContinuationWork,
  attempt: number,
  deps: ContinuationWorkTerminalNoticeDeps,
): void {
  const flowId = work.flowId;
  const delayMs = TERMINAL_NOTICE_RETRY_DELAYS_MS[attempt];
  if (!flowId || delayMs === undefined || retryTimers.has(flowId)) {
    return;
  }
  const timer = setTimeout(() => {
    retryTimers.delete(flowId);
    // Continuation (karmaterminal): admit on the plugin generation current at retry time.
    void runOnCurrentPluginGeneration(async () => {
      try {
        const owed = await readPendingTerminalNoticeWork(flowId);
        if (owed) {
          await deliverPendingTerminalNotice(owed, deps);
        } else {
          // The failed attempt's settle may have committed behind its error:
          // nothing is owed, but its row still needs a delivery timer.
          await scheduleCommittedContinuationNotice(
            prepareTerminalNoticeEntry(flowId, work.sessionKey, terminalNoticeText(work)).id,
            deps,
            deps,
          );
        }
      } catch (err) {
        log.error(
          `[continuation:work-terminal-notice-retry-error] flowId=${flowId} attempt=${attempt + 1}/${TERMINAL_NOTICE_RETRY_DELAYS_MS.length} error=${err instanceof Error ? err.message : String(err)}`,
        );
        armTerminalNoticeRetry(work, attempt + 1, deps);
      }
    });
  }, delayMs);
  timer.unref?.();
  retryTimers.set(flowId, timer);
}

/**
 * Hand off one notice, arming a bounded live retry if the durable enqueue fails.
 *
 * The obligation survives every failure, so it is never lost; the retry only
 * removes the dependency on an unrelated restart.
 */
export async function deliverPendingTerminalNoticeWithRetry(
  work: PendingContinuationWork,
  deps: ContinuationWorkTerminalNoticeDeps = defaultDeps,
): Promise<boolean> {
  try {
    return await deliverPendingTerminalNotice(work, deps);
  } catch (err) {
    log.error(
      `[continuation:work-terminal-notice-error] flowId=${work.flowId ?? "none"} session=${work.sessionKey} error=${err instanceof Error ? err.message : String(err)}`,
    );
    armTerminalNoticeRetry(work, 0, deps);
    return false;
  }
}

/**
 * Replay every notice custody still owes. Safe to call on every startup:
 * records whose notice already reached the delivery queue no longer owe it.
 */
export async function drainPendingTerminalNotices(
  deps: ContinuationWorkTerminalNoticeDeps = defaultDeps,
): Promise<number> {
  let delivered = 0;
  for (const work of await listPendingTerminalNoticeWork()) {
    try {
      if (await deliverPendingTerminalNoticeWithRetry(work, deps)) {
        delivered += 1;
      }
    } catch (err) {
      // The obligation stays set so the next drain retries; never drop it.
      log.error(
        `[continuation:work-terminal-notice-drain-error] flowId=${work.flowId ?? "none"} session=${work.sessionKey} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return delivered;
}
