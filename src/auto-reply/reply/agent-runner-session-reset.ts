// Handles session reset requests produced during agent runner execution.
<<<<<<< HEAD
import type { SessionEntry } from "../../config/sessions.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionTranscriptPath,
} from "../../config/sessions.js";
import { persistSessionResetLifecycle } from "../../config/sessions/session-accessor.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { defaultRuntime } from "../../runtime.js";
import { refreshQueuedFollowupSession, type FollowupRun } from "./queue.js";
=======
import fs from "node:fs";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
  updateSessionStore,
} from "../../config/sessions.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { defaultRuntime } from "../../runtime.js";
import { refreshQueuedFollowupSession, type FollowupRun } from "./queue.js";
import { replayRecentUserAssistantMessages } from "./session-transcript-replay.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

type ResetSessionOptions = {
  failureLabel: string;
  buildLogMessage: (nextSessionId: string) => string;
  cleanupTranscripts?: boolean;
};

const deps = {
  generateSecureUuid,
<<<<<<< HEAD
  persistSessionResetLifecycle,
=======
  updateSessionStore,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  refreshQueuedFollowupSession,
  error: (message: string) => defaultRuntime.error(message),
};

export function setAgentRunnerSessionResetTestDeps(overrides?: Partial<typeof deps>): void {
  Object.assign(deps, {
    generateSecureUuid,
<<<<<<< HEAD
    persistSessionResetLifecycle,
=======
    updateSessionStore,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
  storePath?: string;
  messageThreadId?: string;
  followupRun: FollowupRun;
  onActiveSessionEntry: (entry: SessionEntry) => void;
  onNewSession: (newSessionId: string, nextSessionFile: string) => void;
}): Promise<boolean> {
  if (!params.sessionKey || !params.activeSessionStore || !params.storePath) {
    return false;
  }
  const prevEntry = params.activeSessionStore[params.sessionKey] ?? params.activeSessionEntry;
  if (!prevEntry) {
    return false;
  }
  const prevSessionId = params.options.cleanupTranscripts ? prevEntry.sessionId : undefined;
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
    contextBudgetStatus: undefined,
    systemPromptReport: undefined,
    fallbackNoticeSelectedModel: undefined,
    fallbackNoticeActiveModel: undefined,
    fallbackNoticeReason: undefined,
  };
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const nextSessionFile = resolveSessionTranscriptPath(
    nextSessionId,
    agentId,
    params.messageThreadId,
  );
  nextEntry.sessionFile = nextSessionFile;
  params.activeSessionStore[params.sessionKey] = nextEntry;
  try {
<<<<<<< HEAD
    await deps.persistSessionResetLifecycle({
      agentId,
      cleanupPreviousTranscript: params.options.cleanupTranscripts,
      nextEntry,
      nextSessionFile,
      previousEntry: prevEntry,
      previousSessionId: prevSessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
=======
    await deps.updateSessionStore(params.storePath, (store) => {
      store[params.sessionKey!] = nextEntry;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    });
  } catch (err) {
    deps.error(
      `Failed to persist session reset after ${params.options.failureLabel} (${params.sessionKey}): ${String(err)}`,
    );
  }
<<<<<<< HEAD
=======
  // Silent rotations (compaction/role-ordering) fire without user intent, so
  // preserve recent user/assistant turns for direct-chat continuity.
  await replayRecentUserAssistantMessages({
    sourceTranscript: prevEntry.sessionFile,
    targetTranscript: nextSessionFile,
    newSessionId: nextSessionId,
  });
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  params.followupRun.run.sessionId = nextSessionId;
  params.followupRun.run.sessionFile = nextSessionFile;
  deps.refreshQueuedFollowupSession({
    key: params.queueKey,
    previousSessionId: prevEntry.sessionId,
    nextSessionId,
    nextSessionFile,
  });
  params.onActiveSessionEntry(nextEntry);
  params.onNewSession(nextSessionId, nextSessionFile);
  deps.error(params.options.buildLogMessage(nextSessionId));
<<<<<<< HEAD
=======
  if (params.options.cleanupTranscripts && prevSessionId) {
    const transcriptCandidates = new Set<string>();
    const resolved = resolveSessionFilePath(
      prevSessionId,
      prevEntry,
      resolveSessionFilePathOptions({ agentId, storePath: params.storePath }),
    );
    if (resolved) {
      transcriptCandidates.add(resolved);
    }
    transcriptCandidates.add(resolveSessionTranscriptPath(prevSessionId, agentId));
    for (const candidate of transcriptCandidates) {
      try {
        fs.unlinkSync(candidate);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  return true;
}
