import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { collectKnownSessionGroups } from "../../lib/sessions/grouping.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/navigation.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { resolveChatPaneParentSession } from "./components/chat-pane-header.ts";

/** Capture rendered roster facts without retaining a mutable row as the previous value. */
export function chatSessionPresentationKey(
  state: ChatPageHost,
  publication: ApplicationContext["sessions"]["state"],
  selected: GatewaySessionRow | undefined,
  globalApprovals: ApplicationContext["overlays"]["snapshot"]["approvalQueue"] | undefined,
): string {
  const result = state.sessionsResult;
  const rows = result?.sessions ?? [];
  const approvalSources = new Set(
    [...(state.chatSessionApprovalQueue ?? []), ...(globalApprovals ?? [])]
      .map((approval) => approval.sourceSessionKey)
      .filter((key): key is string => typeof key === "string"),
  );
  return JSON.stringify([
    state.sessionKey,
    resolveChatAgentId(state),
    state.connectionEpoch,
    state.sessionsResultAgentId,
    state.sessionsLoading,
    state.sessionsError,
    selected,
    resolveChatPaneParentSession(selected, rows),
    result?.defaults,
    result?.owners,
    publication.modelOverrides[state.sessionKey],
    Object.hasOwn(publication.modelOverrides, state.sessionKey),
    state.sessions.think(
      state.sessionKey,
      scopedAgentParamsForSession(state, state.sessionKey).agentId,
    ),
    state.sessions.archiveVisibility(selected?.key ?? state.sessionKey),
    collectKnownSessionGroups(publication.groups, publication.result?.sessions ?? []),
    publication.groupSettings,
    [...approvalSources].map((key) => rows.find((row) => areUiSessionKeysEquivalent(row.key, key))),
    // Empty chat renders recent sessions from the whole roster.
    state.chatMessages.length === 0 ? rows : undefined,
  ]);
}
