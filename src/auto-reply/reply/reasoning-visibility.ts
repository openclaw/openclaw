import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import type { ReasoningLevel } from "../thinking.js";
import { registerReplyReasoningVisibility } from "./reasoning-visibility-state.js";
import type { ReplyReasoningVisibility } from "./reasoning-visibility.types.js";
import { isDispatchFinalReplySessionWriterAuthorized } from "./session-writer-delivery-authority.js";

export {
  bindReplyReasoningVisibility,
  isReplyReasoningVisible,
} from "./reasoning-visibility-state.js";

export function canUseReasoningState(
  command: { isAuthorizedSender: boolean; senderIsOwner: boolean },
  gatewayClientScopes: readonly string[] | undefined,
): boolean {
  return (
    command.isAuthorizedSender ||
    command.senderIsOwner ||
    (Array.isArray(gatewayClientScopes) && gatewayClientScopes.includes("operator.admin"))
  );
}

/** The resolved turn can lose visibility, but a later turn cannot authorize its payloads. */
export async function createReplyReasoningVisibility(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  sessionEntry?: SessionEntry;
  authorized: boolean;
  resolvedLevel: ReasoningLevel;
  override?: ReasoningLevel;
  abortSignal?: AbortSignal;
}): Promise<ReplyReasoningVisibility> {
  let queued = false;
  let isQueuedAborted: (() => boolean) | undefined;
  let revoked = false;
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let release = () => {};
  let releaseVisibility = () => {};
  const initialSessionId = params.sessionEntry?.sessionId;
  const initialRevision = params.sessionEntry?.lifecycleRevision;
  const initialLevel = params.sessionEntry?.reasoningLevel;
  const owner: ReplyReasoningVisibility = {
    retainForQueue: (isAborted) => {
      queued = true;
      isQueuedAborted = isAborted;
    },
    releaseDispatch: () => {
      if (!queued) {
        owner.close();
      }
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      releaseVisibility();
      unsubscribe?.();
      unsubscribe = undefined;
      release();
    },
  };
  if (!params.authorized || params.resolvedLevel !== "on" || params.abortSignal?.aborted) {
    return owner;
  }
  unsubscribe = onSessionLifecycleEvent((event) => {
    if (
      event.sessionKey === params.sessionKey &&
      (event.agentId === undefined || event.agentId === params.agentId) &&
      event.reasoningLevel !== undefined &&
      event.reasoningLevel !== "on"
    ) {
      // Explicit off must revoke even when an inline on overrode an already-off session.
      revoked = true;
    }
  });
  const matchesCurrent = (current: SessionEntry | undefined) => {
    if (
      !initialSessionId ||
      !current ||
      current.sessionId !== initialSessionId ||
      current.lifecycleRevision !== initialRevision
    ) {
      return false;
    }
    if (current.reasoningLevel !== initialLevel) {
      return current.reasoningLevel === "on";
    }
    return params.override === "on" || (current.reasoningLevel ?? params.resolvedLevel) === "on";
  };
  const scope = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    projection: "list" as const,
  };
  const assertPreparing = () => {
    params.abortSignal?.throwIfAborted();
    if (closed) {
      throw new DOMException("Reasoning visibility preparation ended", "AbortError");
    }
  };
  try {
    // Capture actor ownership before yielding; incognito metadata never enters disk discovery.
    assertPreparing();
    const memory = captureSessionEntryMetadataRead(scope, () => {});
    const isCurrent = memory
      ? () => matchesCurrent(memory.readCurrent())
      : params.storePath
        ? await withSessionEntryReadOnlyInWorker(scope, assertPreparing, async (read, prepared) => {
            if (!read.ok) {
              throw read.error;
            }
            const source = prepared.source;
            if (!source || !matchesCurrent(read.value)) {
              return () => false;
            }
            // Writer receipts update this retained fact. The wire fence performs no SQL or discovery.
            const retained = retainPreparedSessionEntryPredicate({
              databaseIdentity: `file:${source.databaseIdentity}`,
              sessionKey: resolveSqliteSessionKey(params.sessionKey, source.agentId),
              entry: read.value,
              matches: (_before, after) => matchesCurrent(after),
            });
            release = retained.release;
            return retained.isCurrent;
          })
        : () => false;
    assertPreparing();
    if (revoked) {
      owner.close();
      return owner;
    }
    releaseVisibility = registerReplyReasoningVisibility(owner, (payload) => {
      const aborted = queued ? isQueuedAborted?.() : params.abortSignal?.aborted;
      return (
        !revoked &&
        !closed &&
        !aborted &&
        isCurrent() &&
        isDispatchFinalReplySessionWriterAuthorized(payload, params.storePath)
      );
    });
  } catch {
    // A display-policy preparation failure must suppress reasoning, never the ordinary answer.
    owner.close();
  }
  return owner;
}
