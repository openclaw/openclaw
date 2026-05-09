import { CURRENT_SESSION_VERSION } from "../../agents/transcript/session-transcript-contract.js";
import {
  hasSqliteSessionTranscriptEvents,
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScopeForLocator,
} from "../../config/sessions/transcript-store.sqlite.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";

/** Tail kept so DM continuity survives silent session rotations. */
export const DEFAULT_REPLAY_MAX_MESSAGES = 6;

type SessionRecord = { message?: { role?: unknown } };
type KeptRecord = { role: "user" | "assistant"; event: unknown };

/**
 * Copy the tail of user/assistant JSONL records from a prior transcript into a
 * freshly-rotated one. Tool, system, and compaction records are skipped so
 * replay cannot reshape tool/role ordering, and the tail is aligned and
 * coalesced into alternating user/assistant turns so role-ordering resets
 * cannot immediately recur. Uses async I/O so long transcripts do not block
 * the event loop. Returns 0 on any error.
 */
export async function replayRecentUserAssistantMessages(params: {
  sourceAgentId?: string;
  sourceSessionId?: string;
  sourceTranscript?: string;
  targetAgentId?: string;
  targetTranscript: string;
  newSessionId: string;
  maxMessages?: number;
}): Promise<number> {
  const max = Math.max(0, params.maxMessages ?? DEFAULT_REPLAY_MAX_MESSAGES);
  if (max === 0) {
    return 0;
  }
  try {
    const sourceEvents = loadReplaySourceEvents(params);
    if (!sourceEvents) {
      return 0;
    }
    const kept: KeptRecord[] = [];
    for (const event of sourceEvents) {
      const role = (event as SessionRecord | null)?.message?.role;
      if (role === "user" || role === "assistant") {
        kept.push({ role, event });
      }
    }
    if (kept.length === 0) {
      return 0;
    }
    let startIdx = Math.max(0, kept.length - max);
    while (startIdx < kept.length && kept[startIdx].role === "assistant") {
      startIdx += 1;
    }
    if (startIdx === kept.length) {
      // Retained window is assistant-only; replaying would re-create the same
      // role-ordering hazard this reset path is recovering from.
      return 0;
    }
    const tail = coalesceAlternatingReplayTail(kept.slice(startIdx)).map((entry) => entry.event);
    const targetAgentId =
      params.targetAgentId ??
      params.sourceAgentId ??
      resolveAgentIdFromSessionPath(params.targetTranscript);
    const existingTargetEvents = loadSqliteSessionTranscriptEvents({
      agentId: targetAgentId,
      sessionId: params.newSessionId,
    }).map((entry) => entry.event);
    const targetEvents =
      existingTargetEvents.length > 0
        ? [...existingTargetEvents, ...tail]
        : [
            {
              type: "session",
              version: CURRENT_SESSION_VERSION,
              id: params.newSessionId,
              timestamp: new Date().toISOString(),
              cwd: process.cwd(),
            },
            ...tail,
          ];
    replaceSqliteSessionTranscriptEvents({
      agentId: targetAgentId,
      sessionId: params.newSessionId,
      events: targetEvents,
    });
    return tail.length;
  } catch {
    return 0;
  }
}

function resolveAgentIdFromSessionPath(sessionFile: string): string {
  void sessionFile;
  return DEFAULT_AGENT_ID;
}

function loadReplaySourceEvents(params: {
  sourceAgentId?: string;
  sourceSessionId?: string;
  sourceTranscript?: string;
}): unknown[] | undefined {
  const scopedEvents = loadScopedReplaySourceEvents(params);
  if (scopedEvents !== undefined) {
    return scopedEvents;
  }
  const src = params.sourceTranscript;
  if (!src) {
    return undefined;
  }
  const sourceScope = resolveSqliteSessionTranscriptScopeForLocator({ transcriptLocator: src });
  if (!sourceScope) {
    return undefined;
  }
  return loadSqliteSessionTranscriptEvents(sourceScope).map((entry) => entry.event);
}

function loadScopedReplaySourceEvents(params: {
  sourceAgentId?: string;
  sourceSessionId?: string;
}): unknown[] | undefined {
  if (!params.sourceAgentId?.trim() || !params.sourceSessionId?.trim()) {
    return undefined;
  }
  try {
    const scope = {
      agentId: params.sourceAgentId,
      sessionId: params.sourceSessionId,
    };
    return hasSqliteSessionTranscriptEvents(scope)
      ? loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event)
      : undefined;
  } catch {
    return undefined;
  }
}

// Keep the newest record from each same-role run while ensuring strict provider alternation.
function coalesceAlternatingReplayTail(entries: KeptRecord[]): KeptRecord[] {
  const tail: KeptRecord[] = [];
  for (const entry of entries) {
    const lastIdx = tail.length - 1;
    if (lastIdx >= 0 && tail[lastIdx]?.role === entry.role) {
      tail[lastIdx] = entry;
      continue;
    }
    tail.push(entry);
  }
  return tail;
}
