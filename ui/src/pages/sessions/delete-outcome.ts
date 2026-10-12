import type { ApplicationContext } from "../../app/context.ts";
import type { SessionDeleteTarget } from "../../lib/sessions/session-capability.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import type { SessionDeleteRow } from "./selection.ts";

export function resolveSessionDeleteOutcome(
  context: ApplicationContext,
  requests: readonly SessionDeleteTarget[],
  completedKeys: readonly string[],
  state: {
    selectedSessions: Map<string, SessionDeleteRow>;
    expandedSessionKey: string | null;
    deepLinkSessionKey: string | null;
  },
) {
  const deleted = new Set(completedKeys);
  // A completed predecessor request cannot retire a successor's page state.
  for (const { key, agentId } of requests) {
    if (context.sessions.deletionState(key, agentId) !== "confirmed") {
      deleted.delete(key);
    }
  }
  const selectedSessions = new Map(state.selectedSessions);
  for (const key of deleted) {
    selectedSessions.delete(key);
  }
  const deletedCurrent = [...deleted].find((key) =>
    areUiSessionKeysEquivalent(key, context.gateway.snapshot.sessionKey),
  );
  const agentId = deletedCurrent
    ? (parseAgentSessionKey(deletedCurrent)?.agentId ??
      context.agentSelection.state.selectedId ??
      "main")
    : null;
  return {
    selectedSessions,
    expandedSessionKey:
      state.expandedSessionKey && deleted.has(state.expandedSessionKey)
        ? null
        : state.expandedSessionKey,
    deepLinkSessionKey:
      state.deepLinkSessionKey && deleted.has(state.deepLinkSessionKey)
        ? null
        : state.deepLinkSessionKey,
    selection: agentId
      ? {
          agentId,
          sessionKey: buildAgentMainSessionKey({
            agentId,
            mainKey: resolveUiConfiguredMainKey({
              agentsList: context.agents.state.agentsList,
              hello: context.gateway.snapshot.hello,
            }),
          }),
        }
      : null,
  };
}
