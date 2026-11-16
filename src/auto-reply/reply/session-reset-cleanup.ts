import { clearPreparedEmbeddedAgentSettings } from "../../agents/agent-project-settings.js";
import { stopSessionExecProcesses } from "../../agents/bash-process-control.js";
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
import {
  captureSessionTarget,
  type SessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { isReplyOperationPreBackendPhase } from "../../sessions/session-controller.state.js";
import { clearSessionQueues } from "./queue/cleanup.js";

export class SessionResetCleanupError extends Error {}

export class SessionResetCleanupConflictError extends SessionResetCleanupError {
  constructor() {
    super("Reset did not complete because the session changed before cleanup. Retry /reset.");
  }
}

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
      throw new SessionResetCleanupConflictError();
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
            throw new SessionResetCleanupConflictError();
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

/**
 * Every reset path (chat `/new` and `/reset`, Gateway reset and delete) stops the
 * session's exec processes here, before the replacement conversation is committed:
 * in-flight commands, `background: true` services and adopted survivors. After a
 * reset nothing would manage them. Durable processes are kept.
 */
export async function stopSessionResetProcesses(params: {
  scopeKeys: Array<string | undefined>;
  assertCurrent: () => void;
}): Promise<void> {
  try {
    params.assertCurrent();
    await stopSessionExecProcesses(
      params.scopeKeys.filter((key): key is string => Boolean(key)),
      params.assertCurrent,
    );
  } catch (cause) {
    if (cause instanceof SessionResetCleanupError) {
      throw cause;
    }
    throw new SessionResetCleanupError(
      "Reset did not complete because some session processes could not be confirmed stopped. Inspect them with process list and retry /reset.",
      { cause },
    );
  }
}

/** Chat reset: stop the session's subagents, then (with the parent stopped) its processes. */
export async function stopSessionResetWork(
  params: Parameters<typeof stopSessionResetSubagents>[0],
): Promise<{ stopped: number; failed: number }> {
  const stopped = await stopSessionResetSubagents(params);
  await stopSessionResetProcesses({
    scopeKeys: [params.sessionKey],
    assertCurrent: params.assertCurrent,
  });
  return stopped;
}

export function clearCommittedSessionResetRuntimeState(params: {
  previousSessionEntry: Pick<SessionEntry, "sessionId"> | undefined;
  storePath: string;
  agentId: string;
  sessionKey: string;
  signal?: AbortSignal;
  preserveControllerInputs?: boolean;
  onError: (error: unknown) => void;
}): void {
  if (!params.previousSessionEntry) {
    return;
  }
  try {
    clearSessionResetRuntimeState([params.sessionKey, params.previousSessionEntry.sessionId], {
      activeReplySessionId: params.previousSessionEntry.sessionId,
      controllerTarget: captureSessionTarget({
        storeScope: params.storePath,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        incarnation: params.previousSessionEntry.sessionId,
      }),
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      preserveControllerInputs: params.preserveControllerInputs,
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
    controllerTarget?: SessionTarget;
    sessionKey: string;
    activeReplySessionId?: string;
    preserveControllerInputs?: boolean;
    assertCurrent: () => void;
  },
): void {
  opts.assertCurrent();
  clearEmbeddedSessionPromptStates([opts.activeReplySessionId]);
  clearPreparedEmbeddedAgentSettings([opts.activeReplySessionId]);
  if (opts.activeReplySessionId) {
    clearPromptCacheObservations(opts.activeReplySessionId);
  }
  const cleared = clearSessionQueues(
    keys,
    opts.controllerTarget,
    opts.preserveControllerInputs ? [] : undefined,
    opts.assertCurrent,
  );
  for (const key of cleared) {
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
