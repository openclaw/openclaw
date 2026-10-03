import type { GatewaySessionRow } from "../../api/types.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiSessionNavigationParentKey,
} from "../../lib/sessions/session-key.ts";
import { latestSessionsYieldTimestamp } from "./chat-sessions-yield.ts";

export type ChatSubagentWait = {
  startedAt: number | null;
  child?: { key: string; label: string };
};

export function resolveChatSubagentWait(input: {
  selectedSession: GatewaySessionRow | undefined;
  runActive?: boolean;
  runWorking?: boolean;
  messages: readonly unknown[];
  subagentSessions?: readonly GatewaySessionRow[];
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
  const yieldedAt = latestSessionsYieldTimestamp(input.messages);
  const children = input.subagentSessions?.filter((row) => {
    const parent = resolveUiSessionNavigationParentKey(row);
    return (
      !row.archived &&
      isSessionRunActive(row) &&
      !areUiSessionKeysEquivalent(row.key, session.key) &&
      (parent
        ? areUiSessionKeysEquivalent(parent, session.key)
        : session.childSessions?.some((key) => areUiSessionKeysEquivalent(key, row.key)))
    );
  });
  const child = children?.length === 1 ? children[0] : undefined;
  return {
    startedAt:
      yieldedAt !== null && typeof session.startedAt === "number" && yieldedAt > session.startedAt
        ? yieldedAt
        : null,
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
