import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReasoningLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyReasoningVisibility } from "./reasoning-visibility.types.js";
import { isDispatchFinalReplySessionWriterAuthorized } from "./session-writer-delivery-authority.js";

// Metadata carries an opaque owner, not a caller-supplied visibility callback.
const visibilityByOwner = new WeakMap<object, { isVisible: () => boolean; storePath?: string }>();

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

/** Bind durable reasoning to its producing turn across copies and queued delivery. */
export function bindReplyReasoningVisibility(
  payload: ReplyPayload,
  owner: ReplyReasoningVisibility | undefined,
): void {
  if (payload.isReasoning === true) {
    setReplyPayloadMetadata(payload, { reasoningVisibilityOwner: owner });
  }
}

export function isReplyReasoningVisible(payload: ReplyPayload): boolean {
  const owner = getReplyPayloadMetadata(payload)?.reasoningVisibilityOwner;
  if (payload.isReasoning !== true || owner === undefined) {
    return false;
  }
  try {
    const policy = visibilityByOwner.get(owner);
    return (
      policy?.isVisible() === true &&
      isDispatchFinalReplySessionWriterAuthorized(payload, policy.storePath)
    );
  } catch {
    return false;
  }
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
      visibilityByOwner.delete(owner);
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
    visibilityByOwner.set(owner, {
      storePath: params.storePath,
      isVisible: () => {
        const aborted = queued ? isQueuedAborted?.() : params.abortSignal?.aborted;
        return !revoked && !closed && !aborted && isCurrent();
      },
    });
  } catch {
    // A display-policy preparation failure must suppress reasoning, never the ordinary answer.
    owner.close();
  }
  return owner;
}
