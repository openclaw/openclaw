import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { listRunningSessions } from "../agents/bash-process-registry.js";
import {
  listLiveSubagentRootSessions,
  resolveRootSubagentRequester,
} from "../agents/subagents/registry/subagent-registry-read.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import { captureSessionQueuedInputsForRestart } from "../config/sessions/session-pending-input-history.js";
import { restartResumeSkipReason } from "../config/sessions/session-run-lifecycle-projection.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getAgentRunContext,
  hasAgentRunContextExecutionOwner,
  listLiveAgentRunIds,
} from "../infra/agent-run-registry.js";
import { throwIfSettledRejected } from "../infra/error-graph-internal.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { getSessionControllerEntryForOperation } from "../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../sessions/session-controller.queries.js";
import {
  activeSessionOperations,
  hasCommittedReplyOperationOutcome,
} from "../sessions/session-controller.state.js";
import { resolveExplicitIncognitoAgentSqliteTarget } from "../state/openclaw-agent-db.paths.js";
import { createRestartResumeSummary } from "./session-restart-resume-log.js";

type SessionIdentity = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId?: string;
  hadBackgroundExec?: true;
  needsResume: boolean;
};

/** Snapshot only live owners after admission closes, before shutdown aborts them. */
export async function persistRunningSessionsForRestart(params: {
  cfg: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<void> {
  const summary = createRestartResumeSummary("shutdown");
  const publish = () => summary.publish();
  params.signal?.addEventListener("abort", publish, { once: true });
  try {
    await persistRunningSessions(params, summary);
  } finally {
    params.signal?.removeEventListener("abort", publish);
    publish();
  }
}

async function persistRunningSessions(
  params: { cfg: OpenClawConfig; signal?: AbortSignal },
  summary: ReturnType<typeof createRestartResumeSummary>,
): Promise<void> {
  const assertCurrent = () => params.signal?.throwIfAborted();
  assertCurrent();
  const sessions = new Map<string, SessionIdentity>();
  const add = (input: {
    sessionKey: string;
    agentId?: string;
    storePath?: string;
    sessionId?: string;
    hadBackgroundExec?: true;
    needsResume?: boolean;
  }) => {
    const root = resolveRootSubagentRequester(input.sessionKey, input.agentId);
    const agentId =
      root.agentId ??
      parseAgentSessionKey(root.sessionKey)?.agentId ??
      resolveDefaultAgentId(params.cfg);
    const storePath =
      root.storePath ??
      (root.sessionKey === input.sessionKey ? input.storePath : undefined) ??
      resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
    const skip =
      restartResumeSkipReason(root.sessionKey) ??
      (resolveExplicitIncognitoAgentSqliteTarget(storePath, { agentId }) ? "incognito" : undefined);
    if (skip) {
      summary.record(agentId, root.sessionKey, skip);
      return;
    }
    const key = JSON.stringify([agentId, root.sessionKey]);
    const existing = sessions.get(key);
    if (!existing) {
      summary.record(agentId, root.sessionKey, "persistence-incomplete");
      sessions.set(key, {
        agentId,
        storePath,
        sessionKey: root.sessionKey,
        sessionId: root.sessionKey === input.sessionKey ? input.sessionId : undefined,
        hadBackgroundExec: input.hadBackgroundExec,
        needsResume: input.needsResume !== false,
      });
    } else {
      existing.needsResume ||= input.needsResume !== false;
      if (input.hadBackgroundExec) {
        existing.hadBackgroundExec = true;
      }
    }
  };
  for (const operation of activeSessionOperations()) {
    assertCurrent();
    if (operation.abortSignal.aborted) {
      summary.record(
        operation.agentId ??
          parseAgentSessionKey(operation.key)?.agentId ??
          resolveDefaultAgentId(params.cfg),
        operation.key,
        "already-aborted",
      );
      continue;
    }
    const target = getSessionControllerEntryForOperation(operation).target;
    add({
      sessionKey: operation.key,
      agentId: operation.agentId,
      sessionId: operation.sessionId,
      storePath: target?.physicalStorePath ?? target?.storeScope,
      // Completed replies can retain execution custody only to settle workspace uploads.
      needsResume: !operation.result && !hasCommittedReplyOperationOutcome(operation),
    });
  }
  for (const runId of listLiveAgentRunIds()) {
    assertCurrent();
    if (!hasAgentRunContextExecutionOwner(runId)) {
      continue;
    }
    const operation = findSessionControllerOperationByRunId(runId);
    if (operation && hasCommittedReplyOperationOutcome(operation)) {
      continue;
    }
    const run = getAgentRunContext(runId);
    if (run?.sessionKey) {
      add({ sessionKey: run.sessionKey, agentId: run.agentId, sessionId: run.sessionId });
    }
  }
  for (const root of listLiveSubagentRootSessions()) {
    assertCurrent();
    add(root);
  }
  for (const process of listRunningSessions()) {
    assertCurrent();
    const sessionKey = process.sessionKey ?? process.scopeKey;
    if (sessionKey) {
      add({ sessionKey, agentId: process.agentId, hadBackgroundExec: true });
    }
  }
  const selectors = new Map<string, SessionIdentity[]>();
  for (const session of sessions.values()) {
    const key = JSON.stringify([session.agentId, session.storePath]);
    const batch = selectors.get(key) ?? [];
    batch.push(session);
    selectors.set(key, batch);
  }
  // The replacement owner resolves each selector. Do not rediscover every store
  // before allowing the first marker write to commit.
  const writes = await Promise.allSettled(
    [...selectors.values()].map(async (batch) => {
      assertCurrent();
      const first = batch[0];
      if (!first) {
        return;
      }
      const selected = new Map(batch.map((session) => [session.sessionKey, session]));
      const preserveQueued = await applySessionEntryReplacements<
        Array<{ session: SessionIdentity; preserve: () => void }>
      >({
        agentId: first.agentId,
        storePath: first.storePath,
        sessionKeys: batch.map((session) => session.sessionKey),
        requireWriteSuccess: true,
        assertCommitAllowed: assertCurrent,
        update: async (entries) => {
          const replacements: Array<{ sessionKey: string; entry: InternalSessionEntry }> = [];
          const preserve: Array<{ session: SessionIdentity; preserve: () => void }> = [];
          for (const session of batch) {
            summary.record(session.agentId, session.sessionKey, "session-missing");
          }
          for (const { sessionKey, entry } of entries) {
            assertCurrent();
            const session = selected.get(sessionKey);
            if (!session) {
              continue;
            }
            const skip =
              restartResumeSkipReason(sessionKey, entry) ??
              (session.sessionId && session.sessionId !== entry.sessionId
                ? "session-changed"
                : undefined);
            summary.record(session.agentId, sessionKey, skip ?? "persistence-incomplete");
            if (skip) {
              continue;
            }
            const queued = await captureSessionQueuedInputsForRestart({
              ...session,
              storePath: first.storePath,
              sessionId: entry.sessionId,
            });
            if (!session.needsResume && queued.queuedInputIds.length === 0) {
              summary.record(session.agentId, sessionKey, "reply-completed");
              continue;
            }
            replacements.push({
              sessionKey,
              entry: {
                ...entry,
                resumeAfterRestart: {
                  queuedInputIds: queued.queuedInputIds,
                  ...(session.hadBackgroundExec ? { hadBackgroundExec: true } : {}),
                },
              },
            });
            preserve.push({ session, preserve: queued.preserve });
          }
          return { result: preserve, replacements };
        },
      });
      for (const { session, preserve } of preserveQueued) {
        summary.record(session.agentId, session.sessionKey, "marked");
        preserve();
      }
    }),
  );
  throwIfSettledRejected(writes, "Restart marker persistence failed");
}
