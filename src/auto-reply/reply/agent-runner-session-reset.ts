import type { SessionEntry } from "../../config/sessions.js";
import {
  getSessionEntry,
  mergeSessionEntry,
  resolveAgentIdFromSessionKey,
  upsertSessionEntry,
} from "../../config/sessions.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { defaultRuntime } from "../../runtime.js";
import { refreshQueuedFollowupSession, type FollowupRun } from "./queue.js";
import { replayRecentUserAssistantMessages } from "./session-transcript-replay.js";

type ResetSessionOptions = {
  failureLabel: string;
  buildLogMessage: (nextSessionId: string) => string;
};

const deps = {
  generateSecureUuid,
  getSessionEntry,
  upsertSessionEntry,
  refreshQueuedFollowupSession,
  error: (message: string) => defaultRuntime.error(message),
};

export function setAgentRunnerSessionResetTestDeps(overrides?: Partial<typeof deps>): void {
  Object.assign(deps, {
    generateSecureUuid,
    getSessionEntry,
    upsertSessionEntry,
    refreshQueuedFollowupSession,
    error: (message: string) => defaultRuntime.error(message),
    ...overrides,
  });
}

export async function resetReplyRunSession(params: {
  options: ResetSessionOptions;
  sessionKey?: string;
  queueKey: string;
  activeSessionEntry?: SessionEntry;
  activeSessionStore?: Record<string, SessionEntry>;
  messageThreadId?: string;
  followupRun: FollowupRun;
  onActiveSessionEntry: (entry: SessionEntry) => void;
  onNewSession: (newSessionId: string) => void;
}): Promise<boolean> {
  if (!params.sessionKey) {
    return false;
  }
  const agentId =
    params.followupRun.run.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey) ?? "main";
  const prevEntry =
    params.activeSessionStore?.[params.sessionKey] ??
    params.activeSessionEntry ??
    deps.getSessionEntry({ agentId, sessionKey: params.sessionKey });
  if (!prevEntry) {
    return false;
  }
  const nextSessionId = deps.generateSecureUuid();
  const now = Date.now();
  const nextEntry: SessionEntry = {
    ...prevEntry,
    sessionId: nextSessionId,
    updatedAt: now,
    sessionStartedAt: now,
    usageFamilyKey: prevEntry.usageFamilyKey ?? params.sessionKey,
    usageFamilySessionIds: Array.from(
      new Set([...(prevEntry.usageFamilySessionIds ?? []), prevEntry.sessionId, nextSessionId]),
    ),
    lastInteractionAt: now,
    systemSent: false,
    abortedLastRun: false,
    modelProvider: undefined,
    model: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    totalTokensFresh: false,
    estimatedCostUsd: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    contextTokens: undefined,
    systemPromptReport: undefined,
    fallbackNoticeSelectedModel: undefined,
    fallbackNoticeActiveModel: undefined,
    fallbackNoticeReason: undefined,
  };
  if (params.activeSessionStore) {
    params.activeSessionStore[params.sessionKey] = nextEntry;
  }
  try {
    deps.upsertSessionEntry({
      agentId,
      sessionKey: params.sessionKey,
      entry: mergeSessionEntry(deps.getSessionEntry({ agentId, sessionKey: params.sessionKey }), {
        ...nextEntry,
      }),
    });
  } catch (err) {
    deps.error(
      `Failed to persist session reset after ${params.options.failureLabel} (${params.sessionKey}): ${String(err)}`,
    );
  }
  // Silent rotations (compaction/role-ordering) fire without user intent, so
  // preserve recent user/assistant turns for direct-chat continuity.
  await replayRecentUserAssistantMessages({
    sourceAgentId: agentId,
    sourceSessionId: prevEntry.sessionId,
    targetAgentId: agentId,
    newSessionId: nextSessionId,
  });
  params.followupRun.run.sessionId = nextSessionId;
  deps.refreshQueuedFollowupSession({
    key: params.queueKey,
    previousSessionId: prevEntry.sessionId,
    nextSessionId,
  });
  params.onActiveSessionEntry(nextEntry);
  params.onNewSession(nextSessionId);
  deps.error(params.options.buildLogMessage(nextSessionId));
  return true;
}
