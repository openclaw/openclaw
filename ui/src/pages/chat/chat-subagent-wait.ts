import type { GatewaySessionRow } from "../../api/types.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  areUiSessionKeysEquivalent,
  isDashboardSessionKey,
  resolveUiSessionNavigationParentKey,
} from "../../lib/sessions/session-key.ts";
import { pendingSessionsYield } from "./chat-sessions-yield.ts";
import {
  isSubagentsPanelSession,
  isUnfinishedSubagent,
  spawnedSubagentsRenderKey,
  type SubagentRoster,
} from "./chat-spawned-subagent.ts";

export type ChatSubagentWait = {
  /** When the parent handed off; null when loaded history cannot place it. */
  startedAt: number | null;
  /** The handed-off run, so the wait stays that run's live status. */
  runId?: string;
  /** Unfinished direct subagents; 0 until the pane's own child query has answered. */
  runningCount: number;
  /** Unfinished child sessions that are not subagents; the wait names none of them. */
  sessionCount?: number;
  child?: { key: string; label: string };
};

// A count or a name says which children are left, so it waits for the pane's
// own child query. Rows seeded from another list can hold only some of them.
function unfinishedChildren(session: GatewaySessionRow, roster: SubagentRoster) {
  if (!roster.subagentSessionsHydrated) {
    return [];
  }
  return (roster.subagentSessions ?? []).filter((row) => {
    const parent = resolveUiSessionNavigationParentKey(row);
    return (
      !row.archived &&
      isUnfinishedSubagent(row) &&
      !areUiSessionKeysEquivalent(row.key, session.key) &&
      (parent
        ? areUiSessionKeysEquivalent(parent, session.key)
        : session.childSessions?.some((key) => areUiSessionKeysEquivalent(key, row.key)))
    );
  });
}

/**
 * Everything the transcript reads from the session's subagent roster: the
 * wait and where it is placed, the running count, and the keys that tell
 * memoized rows when any of it changed.
 */
export function projectSubagentStatus(
  input: SubagentRoster & {
    selectedSession: GatewaySessionRow | undefined;
    runActive?: boolean;
    runWorking?: boolean;
    messages: readonly unknown[];
  },
  searchFiltering: boolean,
) {
  const session = input.selectedSession;
  const eligible = session && !session.archived && session.hasActiveSubagentRun === true;
  const shouldWait =
    eligible && !input.runActive && !input.runWorking && !isSessionRunActive(session);
  const pending = shouldWait ? pendingSessionsYield(input.messages) : null;
  const yieldedAt = pending?.timestamp ?? null;
  const handoffAt =
    yieldedAt !== null && typeof session?.startedAt === "number" && yieldedAt > session.startedAt
      ? yieldedAt
      : null;
  const unfinished = eligible ? unfinishedChildren(session, input) : [];
  // Dashboard children count as sessions, never named subagents.
  const children = unfinished.filter((row) => !isDashboardSessionKey(row.key));
  const running = children.length;
  const child = running === 1 ? children[0] : undefined;
  // A hydrated roster with no unfinished children ends the wait.
  const wait: ChatSubagentWait | null =
    shouldWait && (!input.subagentSessionsHydrated || unfinished.length > 0)
      ? {
          // The yield's transcript row can predate the handoff by its whole wrapping
          // step; the parent's run end is the handoff itself.
          startedAt:
            handoffAt !== null &&
            typeof session.endedAt === "number" &&
            session.endedAt >= handoffAt
              ? session.endedAt
              : handoffAt,
          ...(handoffAt !== null && pending?.runId ? { runId: pending.runId } : {}),
          runningCount: running,
          ...(unfinished.length > running ? { sessionCount: unfinished.length - running } : {}),
          ...(child
            ? {
                child: {
                  key: child.key,
                  label: resolveSessionDisplayName(child.key, child),
                },
              }
            : {}),
        }
      : null;
  // The line can lead to the Subagents panel only when that panel lists every
  // subagent it mentions.
  const listed =
    (wait !== null || running > 0) &&
    unfinished.every((row) => isDashboardSessionKey(row.key) || isSubagentsPanelSession(row));
  return {
    wait,
    // Only a loaded handoff places the wait inside its run; search omits it.
    placedWait:
      !searchFiltering && wait?.runId && wait.startedAt !== null
        ? { startedAt: wait.startedAt, runId: wait.runId }
        : undefined,
    running,
    listed,
    // Key only the working line's facts so unrelated roster patches stay memoized.
    statusKey: JSON.stringify(
      wait
        ? [
            wait.startedAt,
            wait.runningCount,
            wait.sessionCount,
            wait.child?.key,
            wait.child?.label,
            listed,
          ]
        : [running, listed],
    ),
    rowsKey: spawnedSubagentsRenderKey(input.subagentSessions),
  };
}
