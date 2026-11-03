// Continuation (karmaterminal): a kept continue_work wake is bound to the recipient authority its
// session had when the work was elected, so it never wakes a session whose recipient changed after
// the election (owner change, visibility narrowing, member removal, delete). Same-owner /new and
// /reset leave the epoch unchanged, so a kept wake still wakes the successor head.
//
// The binding is checked at every boundary a wake crosses: the replay sweep after a restart, the
// dispatcher's handoff, and the turn (or active-turn fold) that would adopt it. A stale wake is
// refused: its record fails with the stable reason, no wake turn runs and no notice reaches the
// session, whose recipient is no longer the one that elected it.
//
// Records elected before the binding existed carry none. The authority row keeps when its epoch
// was last written (session-recipient-authority-types.ts), so an unbound wake is kept only while
// that proves no write since its election: no row, or a last write before `electedAt`. An advance
// after the election refuses it as changed. A row first written after the election, by a capture or
// by an advance the store cannot tell apart, refuses it as unverifiable: a lost legacy wake, logged.
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import { captureSessionRecipientAuthority } from "../../config/sessions/session-accessor.js";
import type { SessionAccessScope } from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  type AdmittedSessionRecipientAuthority,
  withSessionRecipientAuthorityRecords,
} from "../../config/sessions/session-recipient-authority-current.js";
import {
  sessionRecipientAuthorityMatches,
  type SessionRecipientAuthority,
} from "../../config/sessions/session-recipient-authority-types.js";
import { emitContinuationQueueDrainSpan } from "../../infra/continuation-tracer.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { listContinuationRecords } from "./custody/custody-store.js";
import {
  reportRefusedContinuationWork,
  type ContinuationWorkRefusalReason,
  type ContinuationWorkRefusalStage,
} from "./return-refusal.js";
import { decodeWorkState, workToRuntime, type PendingContinuationWork } from "./work-flow-state.js";
import { markPendingWorkFailed } from "./work-store.js";

/** Capture and check resolve the session's authority row as a delegate's binding capture does. */
function workRecipientScope(sessionKey: string): SessionAccessScope {
  const fallbackAgentId = sessionKey.startsWith("agent:")
    ? undefined
    : resolveDefaultAgentId(getRuntimeConfig());
  return { agentId: resolveAgentIdFromSessionKey(sessionKey, fallbackAgentId), sessionKey };
}

/**
 * Captured before the election commits, as a delegate's binding is: a failed capture elects
 * nothing, never an unbound wake. An incognito session has no durable recipient authority, so a
 * continue_work election there fails visibly, as a delegate elected there does.
 */
export async function captureContinuationWorkRecipientAuthority(
  sessionKey: string,
): Promise<SessionRecipientAuthority> {
  return await captureSessionRecipientAuthority(workRecipientScope(sessionKey));
}

function refusalReason(
  record: AdmittedSessionRecipientAuthority,
  work: Pick<PendingContinuationWork, "electedAt" | "recipientAuthority">,
): ContinuationWorkRefusalReason | undefined {
  if (work.recipientAuthority) {
    return record.state !== "unowned" &&
      sessionRecipientAuthorityMatches(work.recipientAuthority, record)
      ? undefined
      : "recipient-authority-changed";
  }
  // Unbound (elected before the binding existed). Every handover writes the row, so no row means
  // none happened; equal times fail closed, because their order is unknown.
  if (record.state === "missing") {
    return undefined;
  }
  if (record.state !== "present") {
    return "recipient-authority-unverifiable";
  }
  if (record.updatedAt < work.electedAt) {
    return undefined;
  }
  return record.updatedAt > record.createdAt
    ? "recipient-authority-changed"
    : "recipient-authority-unverifiable";
}

/**
 * Refuses each work whose binding is stale and returns the rest. A refusal fails the record with
 * its reason in one revision CAS; a lost CAS means another owner moved it, so it is not driven here
 * either. `onRefused` releases what the caller retained for the ended election.
 */
export async function refuseStaleContinuationWork(
  works: readonly PendingContinuationWork[],
  stage: ContinuationWorkRefusalStage,
  onRefused?: (flowId: string) => void,
): Promise<PendingContinuationWork[]> {
  const sessionKeys = [...new Set(works.map((work) => work.sessionKey))];
  const reasons = await withSessionRecipientAuthorityRecords(
    sessionKeys.map(workRecipientScope),
    (records) =>
      works.map((work) => refusalReason(records[sessionKeys.indexOf(work.sessionKey)]!, work)),
  );
  const kept: PendingContinuationWork[] = [];
  for (const [index, work] of works.entries()) {
    const reason = reasons[index];
    if (!reason) {
      kept.push(work);
      continue;
    }
    // No terminal notice: the session's current recipient is not the one that elected the work.
    if (!work.flowId || !(await markPendingWorkFailed(work, reason))) {
      continue;
    }
    reportRefusedContinuationWork({
      stage,
      reason,
      sessionKey: work.sessionKey,
      flowId: work.flowId,
    });
    emitContinuationQueueDrainSpan({
      drainedCount: 0,
      drainedContinuationCount: 0,
      refusedCount: 1,
      refusalReason: reason,
      traceparent: work.traceparent,
    });
    onRefused?.(work.flowId);
  }
  return kept;
}

/**
 * The replay boundary: before startup recovery drives any wake, refuse every live work whose
 * authority moved while the Gateway was down, due or not. A durably delivered or cancel-fenced
 * record is left to its owner; an undecodable one to the consume path that fails it.
 */
export async function refuseStaleContinuationWorkAtReplay(): Promise<void> {
  const works = (
    await listContinuationRecords({ kinds: ["work"], statuses: ["queued", "running"] })
  ).flatMap((record) => {
    const state = record.cancelRequestedAt === undefined ? decodeWorkState(record) : undefined;
    return state && !state.succeeded
      ? [workToRuntime(record, state, record.status === "running" ? "running" : "queued")]
      : [];
  });
  if (works.length > 0) {
    await refuseStaleContinuationWork(works, "replay");
  }
}
