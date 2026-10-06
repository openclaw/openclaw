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

/**
 * A wait behind a loaded handoff is that run's own status. Any other wait
 * follows a turn that already ended, so it stays a row after the transcript.
 */
function placedSubagentWait(
  wait: ChatSubagentWait | null,
): { startedAt: number; runId: string } | undefined {
  return wait?.runId && wait.startedAt !== null
    ? { startedAt: wait.startedAt, runId: wait.runId }
    : undefined;
}

/**
 * Everything the working line draws about subagents, so rows without one keep
 * memoizing across roster patches.
 */
function subagentStatusRenderKey(wait: ChatSubagentWait | null, running: number): string {
  return JSON.stringify(
    wait
      ? [wait.startedAt, wait.runningCount, wait.sessionCount, wait.child?.key, wait.child?.label]
      : [running],
  );
}

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
 * Unfinished direct subagents to mention beside the session's own work; 0 when
 * unknown. Child sessions opened in their own right are not subagents.
 */
function countRunningSubagents(
  input: SubagentRoster & { selectedSession: GatewaySessionRow | undefined },
): number {
  const session = input.selectedSession;
  return session && !session.archived && session.hasActiveSubagentRun === true
    ? unfinishedChildren(session, input).filter((row) => !isDashboardSessionKey(row.key)).length
    : 0;
}

export function resolveChatSubagentWait(
  input: SubagentRoster & {
    selectedSession: GatewaySessionRow | undefined;
    runActive?: boolean;
    runWorking?: boolean;
    messages: readonly unknown[];
  },
): ChatSubagentWait | null {
  const session = input.selectedSession;
  if (
    !session ||
    session.archived ||
    session.hasActiveSubagentRun !== true ||
    input.runActive ||
    input.runWorking ||
    isSessionRunActive(session)
  ) {
    return null;
  }
  const pending = pendingSessionsYield(input.messages);
  const yieldedAt = pending?.timestamp ?? null;
  const handoffAt =
    yieldedAt !== null && typeof session.startedAt === "number" && yieldedAt > session.startedAt
      ? yieldedAt
      : null;
  const unfinished = unfinishedChildren(session, input);
  if (input.subagentSessionsHydrated && unfinished.length === 0) {
    // Every child the pane knows has finished. The resumed run draws the next
    // status; a wait line here could only say it is waiting on nothing.
    return null;
  }
  // A child session opened in its own right is not a subagent: it is counted
  // without a name, and only once no subagent is left.
  const children = unfinished.filter((row) => !isDashboardSessionKey(row.key));
  const child = children.length === 1 ? children[0] : undefined;
  return {
    // The yield's transcript row can predate the handoff by its whole wrapping
    // step; the parent's run end is the handoff itself.
    startedAt:
      handoffAt !== null && typeof session.endedAt === "number" && session.endedAt >= handoffAt
        ? session.endedAt
        : handoffAt,
    ...(handoffAt !== null && pending?.runId ? { runId: pending.runId } : {}),
    runningCount: children.length,
    ...(unfinished.length > children.length
      ? { sessionCount: unfinished.length - children.length }
      : {}),
    ...(child
      ? {
          child: {
            key: child.key,
            label: resolveSessionDisplayName(child.key, child),
          },
        }
      : {}),
  };
}

/**
 * Everything the transcript reads from the session's subagent roster: the
 * wait and where it is placed, the running count, and the keys that tell
 * memoized rows when any of it changed.
 */
export function projectSubagentStatus(
  input: Parameters<typeof resolveChatSubagentWait>[0],
  searchFiltering: boolean,
) {
  const wait = resolveChatSubagentWait(input);
  const running = countRunningSubagents(input);
  return {
    wait,
    // Search results omit the live wait line.
    placedWait: searchFiltering ? undefined : placedSubagentWait(wait),
    running,
    statusKey: subagentStatusRenderKey(wait, running),
    rowsKey: spawnedSubagentsRenderKey(input.subagentSessions),
  };
}
