import { clearPreparedEmbeddedAgentSettings } from "../../agents/agent-project-settings.js";
import { clearPromptCacheObservations } from "../../agents/embedded-agent-runner/prompt-cache-observability.js";
import { clearEmbeddedSessionPromptStates } from "../../agents/embedded-agent-runner/session-prompt-state.js";
import { killSessionSubagentRuns } from "../../agents/subagents/registry/subagent-control-kill.js";
import { retainPreparedSessionGenerationFacts } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { projectSessionSharingEntry } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { withSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  peekSystemEventEntries,
} from "../../infra/system-events.js";
import {
  agentSessionKeysMatchByRequestKey,
  normalizeAgentId,
  normalizeOptionalAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import {
  getSessionControllerOperation,
  stopReplyOperationForRestart,
} from "../../sessions/session-controller.js";
import type { SessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { isReplyOperationPreBackendPhase } from "../../sessions/session-controller.state.js";
import { abortContinuationDispatchClaims } from "../continuation/continuation-dispatch-claims.js";
import { clearDelegateDispatchHedge } from "../continuation/delegate-dispatch-hedge.js";
import {
  cancelSessionContinuations,
  retireReplacedHeadContinuations,
} from "../continuation/session-reset.js";
import { clearTrackedContinuationTimers } from "../continuation/state.js";
import { clearContinuationWorkDispatch } from "../continuation/work-dispatch.js";
import {
  releaseSessionWorkOperatorContinuations,
  releaseWorkOperatorContinuation,
} from "../continuation/work-operator-continuation.js";
import { clearSessionQueues } from "./queue/cleanup.js";

export class SessionResetCleanupError extends Error {}

/** Prepare parent facts once; cleanup observes the entry writer's in-process receipts. */
export async function prepareSessionResetCleanupGuard(params: {
  agentId: string;
  storePath: string;
  sessionKey: string;
  expectedSession: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined;
  assertCurrent?: () => void;
}): Promise<{ assertCurrent: () => void; release: () => void }> {
  const memory = captureSessionEntryMetadataRead(params, () => {});
  const assertEntry = (
    current: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | null | undefined,
  ) => {
    params.assertCurrent?.();
    if (
      current?.sessionId !== params.expectedSession?.sessionId ||
      current?.lifecycleRevision !== params.expectedSession?.lifecycleRevision
    ) {
      throw new SessionResetCleanupError(
        "Reset did not complete because the session changed before cleanup. Retry /reset.",
      );
    }
  };
  if (memory) {
    return {
      assertCurrent: () => assertEntry(memory.readCurrent()),
      release() {},
    };
  }
  return withSessionEntriesFromStoreInWorker(
    {
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKeys: [params.sessionKey],
      snapshotFields: [],
    },
    async ({ result }) => {
      const entry = result.entries.find((row) => row.sessionKey === params.sessionKey)?.entry;
      assertEntry(entry);
      const identity = result.databaseIdentity?.identity;
      if (!identity) {
        return { assertCurrent: () => params.assertCurrent?.(), release() {} };
      }
      const retained = retainPreparedSessionGenerationFacts({
        databaseIdentity: `file:${identity}`,
        sessionKey: params.sessionKey,
        entry: entry ? projectSessionSharingEntry(entry) : undefined,
      });
      return {
        assertCurrent: () => {
          const current = retained.readCurrent();
          if (current === undefined) {
            throw new SessionResetCleanupError(
              "Reset did not complete because the session changed before cleanup. Retry /reset.",
            );
          }
          assertEntry(current);
        },
        release: retained.release,
      };
    },
  );
}

/** Reset must report unfinished child cleanup before committing a fresh conversation. */
export async function stopSessionResetSubagents(
  params: Parameters<typeof killSessionSubagentRuns>[0] & {
    assertCurrent: () => void;
    beforeKill?: () => boolean | Promise<boolean>;
  },
): Promise<{ stopped: number; failed: number }> {
  try {
    // Hooks and child finalizers can yield after reset accepted its parent. Fence
    // that incarnation before selection and at every child cancellation boundary.
    params.assertCurrent();
    const result = await killSessionSubagentRuns(params);
    params.assertCurrent();
    if (result.status === "error") {
      throw new Error(result.error);
    }
    return { stopped: result.killed, failed: 0 };
  } catch (cause) {
    if (cause instanceof SessionResetCleanupError) {
      throw cause;
    }
    throw new SessionResetCleanupError(
      "Reset did not complete because some subagent tasks could not be stopped. Inspect the remaining tasks and retry /reset.",
      { cause },
    );
  }
}

type SessionRuntimeCleanupReason = "new" | "reset" | "delete" | "idle" | "daily";

function interruptsContinuationAuthority(reason: SessionRuntimeCleanupReason): boolean {
  return reason === "new" || reason === "reset" || reason === "delete";
}

/**
 * Reset clears only keys the resetting agent owns: custody, follow-up mailboxes,
 * claims and timers for another agent's qualified key stay put. An unqualified
 * key (raw `global`, a legacy alias, a session id) names no agent and counts as
 * the resetting agent's own. Custody and mailboxes under a raw shared key carry
 * no agent dimension, so that case is NOT proven cross-agent safe: another
 * agent's work under the same raw key is cleared too. Known ambiguity.
 */
function isOwnedByResettingAgent(key: string, agentId: string): boolean {
  const owner = parseAgentSessionKey(key)?.agentId;
  return !owner || owner === normalizeAgentId(agentId);
}

/** Clears queued follow-ups and pending system events visible to the resetting agent. */
export async function clearSessionResetRuntimeState(
  keys: Array<string | undefined>,
  opts: {
    agentId: string;
    controllerTarget?: SessionTarget;
    sessionKey: string;
    reason: SessionRuntimeCleanupReason;
    activeReplySessionId?: string;
    assertCurrent: () => void;
  },
): Promise<void> {
  opts.assertCurrent();
  const ownedKeys = [
    ...new Set(keys.flatMap((key) => (typeof key === "string" && key.trim() ? [key.trim()] : []))),
  ].filter((key) => isOwnedByResettingAgent(key, opts.agentId));
  const interruptContinuations = interruptsContinuationAuthority(opts.reason);
  // Delete ends the session's custody. /new and /reset end only what the replaced head owned;
  // the elections they keep, with their operator custody, are re-armed once the reset settles.
  const endsSession = opts.reason === "delete";
  if (interruptContinuations) {
    // Durable authority must close before timers, waiters, or queues are destroyed.
    // A persistence failure leaves every transient claim path intact for retry.
    for (const key of ownedKeys) {
      if (endsSession) {
        await cancelSessionContinuations(key, opts.assertCurrent);
        releaseSessionWorkOperatorContinuations(key);
        continue;
      }
      for (const recordId of await retireReplacedHeadContinuations(key, opts.assertCurrent)) {
        releaseWorkOperatorContinuation(recordId);
      }
    }
    opts.assertCurrent();
  }

  clearEmbeddedSessionPromptStates([opts.activeReplySessionId]);
  clearPreparedEmbeddedAgentSettings([opts.activeReplySessionId]);
  if (opts.activeReplySessionId) {
    clearPromptCacheObservations(opts.activeReplySessionId);
  }
  const cleared = clearSessionQueues(
    ownedKeys,
    opts.controllerTarget,
    undefined,
    opts.assertCurrent,
  );
  for (const key of cleared) {
    opts.assertCurrent();
    if (interruptContinuations) {
      abortContinuationDispatchClaims(key);
      clearContinuationWorkDispatch(key);
      clearDelegateDispatchHedge(key);
      clearTrackedContinuationTimers(key);
    }
    const owner = parseAgentSessionKey(key)?.agentId;
    if (owner && owner !== normalizeAgentId(opts.agentId)) {
      continue;
    }
    const queueKey = resolveSystemEventQueueKey(key, opts.agentId);
    consumeSelectedSystemEventEntries(queueKey, peekSystemEventEntries(queueKey));
  }

  if (opts.activeReplySessionId) {
    opts.assertCurrent();
    const operation = getSessionControllerOperation(opts.sessionKey, opts.controllerTarget);
    const ownerAgentId =
      normalizeOptionalAgentId(operation?.agentId) ?? parseAgentSessionKey(operation?.key)?.agentId;
    if (
      operation &&
      ownerAgentId === normalizeAgentId(opts.agentId) &&
      operation.sessionId === opts.activeReplySessionId &&
      cleared.some(
        (key) =>
          key !== opts.activeReplySessionId &&
          agentSessionKeysMatchByRequestKey(operation.key, key),
      )
    ) {
      if (!isReplyOperationPreBackendPhase(operation.phase)) {
        opts.assertCurrent();
        stopReplyOperationForRestart(operation);
      }
    }
  }
}
