// Small run-scoped helpers lifted out of runReplyAgent so the reply entry point
// stays inside its file-size budget. Each takes its state explicitly instead of
// closing over the run; runReplyAgent keeps thin local bindings at the call
// sites so existing callers are unchanged.
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { logVerbose } from "../../globals.js";
import { hasSuccessfulTerminalSourceReplyDelivery } from "./agent-runner-core.js";
import type { FollowupRun } from "./queue/types.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";

/**
 * Report a queue-cap rejection as a skipped admission without displacing an
 * observer the caller already installed. `queue-cap-old` is excluded: that
 * disposition retires an older queued source, not this run's admission.
 */
export function bindQueueCapDispositionAdmission(params: {
  followupRun: FollowupRun;
  replyOperationRunState: ReplyOperationRunState | undefined;
}): void {
  const observe = params.followupRun.onQueueDisposition;
  params.followupRun.onQueueDisposition = (disposition) => {
    observe?.(disposition);
    if (params.replyOperationRunState && disposition !== "queue-cap-old") {
      params.replyOperationRunState.admission = { status: "skipped", reason: "queue-cap" };
    }
  };
}

/**
 * Keep the in-memory session snapshot aligned with the pending-reset write
 * boundary. A zero `updatedAt` is preserved so a never-touched entry is not
 * promoted into looking recently active.
 */
export async function touchSessionEntryUpdatedAt(params: {
  sessionEntry: SessionEntry | undefined;
  sessionStore: Record<string, SessionEntry> | undefined;
  sessionKey: string | undefined;
  storePath: string | undefined;
}): Promise<void> {
  const { sessionEntry, sessionStore, sessionKey, storePath } = params;
  if (!sessionEntry || !sessionStore || !sessionKey) {
    return;
  }
  const updatedAt = sessionEntry.updatedAt === 0 ? 0 : Date.now();
  sessionEntry.updatedAt = updatedAt;
  sessionStore[sessionKey] = sessionEntry;
  if (storePath) {
    await updateSessionEntry({ storePath, sessionKey }, () => ({ updatedAt }), {
      skipMaintenance: true,
      takeCacheOwnership: true,
    });
  }
}

/**
 * Decide whether this run already put something visible in front of the user.
 *
 * Accepted or in-flight blocks settle first: a terminal failure may only stay
 * silent once the pipeline has stopped producing visible output.
 */
export async function resolveVisibleReplyDeliveryOutcome(params: {
  blockReplyPipeline: {
    didStreamTerminalReply?: () => boolean;
    isAborted: () => boolean;
    flush: (options: { force: boolean }) => Promise<unknown>;
  } | null;
  didDeliverVisiblePartialReply: () => boolean;
}): Promise<boolean> {
  try {
    await params.blockReplyPipeline?.flush({ force: true });
  } catch (flushError) {
    logVerbose(
      `failed to flush streamed reply blocks before surfacing run failure: ${String(flushError)}`,
    );
  }
  return (
    params.didDeliverVisiblePartialReply() ||
    hasSuccessfulTerminalSourceReplyDelivery({ blockReplyPipeline: params.blockReplyPipeline })
  );
}
