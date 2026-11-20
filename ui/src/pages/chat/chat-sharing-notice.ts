import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionMemberPermissionLevel } from "../../../../packages/gateway-protocol/src/schema/sessions-sharing.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { readChatThreadMessageIdentity } from "../../lib/chat/history-message-identity.ts";
import { uiConversationMatches } from "../../lib/sessions/session-key.ts";
import { resolveChatAgentId } from "./chat-agent-id.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import type { ChatState } from "./chat-state-contract.ts";

registerChatSessionEnglish();

export type ChatSharingNotice = {
  key: string;
  action: "member-added" | "member-access-changed";
  identityId: string;
  access: SessionMemberPermissionLevel;
  actorLabel?: string;
  timestamp: number;
  /** A live presentation anchor, never a stored conversation message. */
  afterMessageId: string | null | undefined;
};

type SharingNoticeScope = Pick<
  ChatState,
  "client" | "connectionEpoch" | "sessionKey" | "currentSessionId"
> & {
  agentId: string | undefined;
  subscriptionGeneration: number;
  notices: readonly ChatSharingNotice[];
};

const sharingNotices = new WeakMap<ChatState, SharingNoticeScope>();
const noNotices: readonly ChatSharingNotice[] = [];

function currentScope(state: ChatState, agentId: string | undefined) {
  const scope = sharingNotices.get(state);
  if (
    state.connected &&
    scope?.client === state.client &&
    scope?.connectionEpoch === state.connectionEpoch &&
    scope?.sessionKey === state.sessionKey &&
    scope?.currentSessionId === state.currentSessionId &&
    scope?.agentId === agentId &&
    scope?.subscriptionGeneration === chatHistoryRequests(state).subscriptionGeneration
  ) {
    return scope;
  }
  sharingNotices.delete(state);
  return undefined;
}

/** Sharing broadcasts have no history/replay contract; retain them only in this live pane. */
export function currentChatSharingNotices(
  state: ChatState | undefined,
  agentId = state ? resolveChatAgentId(state) : undefined,
): readonly ChatSharingNotice[] {
  return state ? (currentScope(state, agentId)?.notices ?? noNotices) : noNotices;
}

export function clearChatSharingNotices(state: ChatState): void {
  sharingNotices.delete(state);
}

export function applyChatSharingNoticeEvent(
  state: ChatState,
  event: GatewayEventFrame,
  agentId = resolveChatAgentId(state),
): boolean {
  const source = asNullableRecord(event.payload);
  if (
    !state.connected ||
    !state.client ||
    (event.event !== "session.sharing" && event.event !== "session.sharing.evidence") ||
    (source?.action !== "member-added" && source?.action !== "member-access-changed") ||
    (source.access !== "read" && source.access !== "suggest" && source.access !== "send") ||
    typeof source.ts !== "number" ||
    !Number.isSafeInteger(source.ts) ||
    source.ts < 0
  ) {
    return false;
  }
  const sessionKey = normalizeOptionalString(source.sessionKey);
  const eventAgentId = normalizeOptionalString(source.agentId);
  const identityId = normalizeOptionalString(source.identityId);
  if (
    !sessionKey ||
    !eventAgentId ||
    !identityId ||
    !uiConversationMatches(state, state.sessionKey, sessionKey, eventAgentId, agentId)
  ) {
    return false;
  }
  const actor = event.event === "session.sharing" ? asNullableRecord(source.actor) : null;
  const actorLabel = normalizeOptionalString(actor?.label) ?? normalizeOptionalString(actor?.id);
  const key = `sharing:${JSON.stringify([source.action, identityId, source.access, source.ts, actorLabel])}`;
  const scope = currentScope(state, agentId);
  if (scope?.notices.some((notice) => notice.key === key)) {
    return false;
  }
  const notice: ChatSharingNotice = {
    key,
    action: source.action,
    identityId,
    access: source.access,
    actorLabel,
    timestamp: source.ts,
    afterMessageId: state.chatMessages.length
      ? (readChatThreadMessageIdentity(state.chatMessages.at(-1))?.id ?? undefined)
      : null,
  };
  sharingNotices.set(state, {
    client: state.client,
    connectionEpoch: state.connectionEpoch,
    sessionKey: state.sessionKey,
    currentSessionId: state.currentSessionId,
    agentId,
    subscriptionGeneration: chatHistoryRequests(state).subscriptionGeneration,
    notices: [...(scope?.notices ?? noNotices), notice],
  });
  return true;
}

/** Translate at presentation time; unknown actors are never attributed to the current viewer. */
export function projectChatSharingNotice(
  notice: ChatSharingNotice,
): Extract<ChatItem, { kind: "notice" }> {
  const action = notice.action === "member-added" ? "invited" : "accessChanged";
  return {
    kind: "notice",
    key: notice.key,
    timestamp: notice.timestamp,
    icon: "users",
    showTimestamp: true,
    text: "",
    label: t(`chat.sharingNotice.${action}${notice.actorLabel ? "ByActor" : ""}`, {
      identity: notice.identityId,
      access: t(`chat.sharingNotice.access.${notice.access}`),
      actor: notice.actorLabel ?? "",
    }),
  };
}
