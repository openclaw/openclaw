import { clearPreparedEmbeddedAgentSettings } from "../../agents/agent-project-settings.js";
import { clearEmbeddedSessionForkSnapshot } from "../../agents/embedded-agent-runner/session-fork.js";
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
import { clearSessionLifecycleQueues } from "./queue/cleanup.js";
import {
  clearReplyRunForResetBySessionId,
  resolveActiveReplyOperationForSessionId,
} from "./reply-run-registry.js";

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
  params: Parameters<typeof killSessionSubagentRuns>[0] & { assertCurrent: () => void },
): Promise<void> {
  try {
    // Hooks and child finalizers can yield after reset accepted its parent. Fence
    // that incarnation before selection and at every child cancellation boundary.
    params.assertCurrent();
    const result = await killSessionSubagentRuns(params);
    params.assertCurrent();
    if (result.status === "error") {
      throw new Error(result.error);
    }
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

export function clearCommittedSessionResetRuntimeState(params: {
  previousSessionEntry: Pick<SessionEntry, "sessionId"> | undefined;
  agentId: string;
  sessionKey: string;
  signal?: AbortSignal;
  onError: (error: unknown) => void;
}): void {
  if (!params.previousSessionEntry) {
    return;
  }
  try {
    clearSessionResetRuntimeState([params.sessionKey, params.previousSessionEntry.sessionId], {
      activeReplySessionId: params.previousSessionEntry.sessionId,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      assertCurrent: () => params.signal?.throwIfAborted(),
    });
  } catch (error) {
    params.onError(error);
  }
}

/** Clears queued follow-ups and pending system events visible to the resetting agent. */
export function clearSessionResetRuntimeState(
  keys: Array<string | undefined>,
  opts: {
    agentId: string;
    sessionKey: string;
    activeReplySessionId?: string;
    assertCurrent: () => void;
  },
): void {
  opts.assertCurrent();
  clearEmbeddedSessionPromptStates([opts.activeReplySessionId]);
  clearPreparedEmbeddedAgentSettings([opts.activeReplySessionId]);
  if (opts.activeReplySessionId) {
    clearEmbeddedSessionForkSnapshot(opts.activeReplySessionId);
  }
  const cleared = clearSessionLifecycleQueues({
    keys,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    sessionId: opts.activeReplySessionId,
    assertCurrent: opts.assertCurrent,
  });
  for (const key of cleared.keys) {
    opts.assertCurrent();
    const owner = parseAgentSessionKey(key)?.agentId;
    if (owner && owner !== normalizeAgentId(opts.agentId)) {
      continue;
    }
    const queueKey = resolveSystemEventQueueKey(key, opts.agentId);
    consumeSelectedSystemEventEntries(queueKey, peekSystemEventEntries(queueKey));
  }

  if (opts.activeReplySessionId) {
    opts.assertCurrent();
    const operation = resolveActiveReplyOperationForSessionId(opts.activeReplySessionId);
    const ownerAgentId =
      normalizeOptionalAgentId(operation?.agentId) ?? parseAgentSessionKey(operation?.key)?.agentId;
    if (
      operation &&
      ownerAgentId === normalizeAgentId(opts.agentId) &&
      operation.sessionId === opts.activeReplySessionId &&
      cleared.keys.some(
        (key) =>
          key !== opts.activeReplySessionId &&
          agentSessionKeysMatchByRequestKey(operation.key, key),
      )
    ) {
      clearReplyRunForResetBySessionId(opts.activeReplySessionId);
    }
  }
}
