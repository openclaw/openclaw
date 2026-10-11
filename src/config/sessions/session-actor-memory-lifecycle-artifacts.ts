import { isDeepStrictEqual } from "node:util";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { SessionLifecycleArtifactCleanupParams } from "./session-accessor.lifecycle-types.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import type { SessionActorMemoryWindow } from "./session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type MemoryLifecycleArtifactInput = Pick<
  SessionLifecycleArtifactCleanupParams,
  | "sessionKeySegmentPrefix"
  | "transcriptContentMarker"
  | "orphanTranscriptMinAgeMs"
  | "pluginOwnerId"
> & { nowMs: number };
export type MemoryLifecycleArtifactPlan = {
  entries: Array<{ sessionKey: string; expected: SessionEntry }>;
  windows: Array<{ sessionKey: string; sessionId: string }>;
};

/** Selection stays with the memory owner; no transcript bodies cross this boundary. */
export function planMemoryLifecycleArtifacts(
  context: SessionActorMemoryStorageContext,
  input: MemoryLifecycleArtifactInput,
  preparedEntries?: ReadonlyMap<string, SessionEntry>,
): MemoryLifecycleArtifactPlan {
  const oldEnough = (window: SessionActorMemoryWindow, entry?: SessionEntry) => {
    const updatedAt = window.events.reduce(
      (latest, row) => Math.max(latest, row.createdAt ?? 0),
      entry?.updatedAt ?? 0,
    );
    return input.nowMs - updatedAt >= input.orphanTranscriptMinAgeMs;
  };
  const foreign = (window: SessionActorMemoryWindow) =>
    Boolean(
      input.pluginOwnerId &&
      window.hot.entry?.pluginOwnerId &&
      window.hot.entry.pluginOwnerId !== input.pluginOwnerId,
    );
  const plan: MemoryLifecycleArtifactPlan = { entries: [], windows: [] };
  const retained = new Set<string>();
  const removed = new Set<string>();
  for (const [sessionKey, state] of context.entries()) {
    const entry = state.hot.entry;
    if (!entry) {
      continue;
    }
    const segment = parseAgentSessionKey(sessionKey)?.rest ?? sessionKey;
    const references = new Set(collectSessionStateIdsForEntry(entry));
    if (
      (!preparedEntries || isDeepStrictEqual(entry, preparedEntries.get(sessionKey))) &&
      segment.startsWith(input.sessionKeySegmentPrefix) &&
      oldEnough(state, entry) &&
      !foreign(state) &&
      ![...state.historicalWindows].some(([id, window]) => references.has(id) && foreign(window))
    ) {
      context.get(sessionKey);
      plan.entries.push({ sessionKey, expected: entry });
      removed.add(sessionKey);
    } else {
      for (const id of references) {
        retained.add(id);
      }
    }
  }
  for (const [sessionKey, state] of context.entries()) {
    if (removed.has(sessionKey)) {
      continue;
    }
    for (const [sessionId, window] of state.historicalWindows) {
      if (
        !retained.has(sessionId) &&
        !foreign(window) &&
        oldEnough(window) &&
        window.events.some((row) => row.eventJson.includes(input.transcriptContentMarker))
      ) {
        context.get(sessionKey);
        plan.windows.push({ sessionKey, sessionId });
      }
    }
  }
  return plan;
}
