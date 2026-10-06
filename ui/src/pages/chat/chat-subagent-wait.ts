import type { GatewaySessionRow } from "../../api/types.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  areUiSessionKeysEquivalent,
  isDashboardSessionKey,
  resolveUiSessionNavigationParentKey,
} from "../../lib/sessions/session-key.ts";
import { pendingSessionsYield } from "./chat-sessions-yield.ts";

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
export function placedSubagentWait(
  wait: ChatSubagentWait | null,
): { startedAt: number; runId: string } | undefined {
  return wait?.runId && wait.startedAt !== null
    ? { startedAt: wait.startedAt, runId: wait.runId }
    : undefined;
}

/** Everything the wait line draws, so rows without one keep memoizing across roster patches. */
export function subagentWaitRenderKey(wait: ChatSubagentWait | null): string {
  return wait
    ? JSON.stringify([
        wait.startedAt,
        wait.runningCount,
        wait.sessionCount,
        wait.child?.key,
        wait.child?.label,
      ])
    : "";
}

export function resolveChatSubagentWait(input: {
  selectedSession: GatewaySessionRow | undefined;
  runActive?: boolean;
  runWorking?: boolean;
  messages: readonly unknown[];
  subagentSessions?: readonly GatewaySessionRow[];
  subagentSessionsHydrated?: boolean;
}): ChatSubagentWait | null {
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
  // A count or a name says which children are left, so it waits for the pane's
  // own child query. Rows seeded from another list can hold only some of them.
  const unfinished = input.subagentSessionsHydrated
    ? (input.subagentSessions ?? []).filter((row) => {
        const parent = resolveUiSessionNavigationParentKey(row);
        return (
          !row.archived &&
          // A child that handed off to its own subagents is still unfinished.
          (isSessionRunActive(row) || row.hasActiveSubagentRun === true) &&
          !areUiSessionKeysEquivalent(row.key, session.key) &&
          (parent
            ? areUiSessionKeysEquivalent(parent, session.key)
            : session.childSessions?.some((key) => areUiSessionKeysEquivalent(key, row.key)))
        );
      })
    : [];
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
