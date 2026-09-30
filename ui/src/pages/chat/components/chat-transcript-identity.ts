import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { classifySessionKind } from "../../../../../src/sessions/classify-session-kind.js";
import {
  normalizeRoleForGrouping,
  resolveMessageRole,
  resolveMessageSender,
} from "../../../lib/chat/message-normalizer.ts";
import { sessionParticipantIdentityKey } from "../../../lib/chat/sender-label.ts";
import {
  isSubagentSessionKey,
  isUiGlobalScopeConfigured,
  parseAgentSessionKey,
  resolveUiGlobalAliasAgentId,
} from "../../../lib/sessions/session-key.ts";
import type { buildCachedChatItems } from "../chat-thread.ts";
import { hasForwardedSource } from "../chat-turn-boundary.ts";
import { resolveChatDefaultAvatarPlacement } from "./chat-author-avatar.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";

export function resolveTranscriptParticipants(
  props: Pick<ChatThreadProps, "selectedSession" | "userId" | "messages" | "pendingInputs">,
) {
  const activeSession = props.selectedSession;
  // Use unfiltered history and retained participants so searching or paging away
  // another person's messages cannot turn a shared conversation into a solo one.
  const showOwnSenderName =
    (activeSession?.expandedParticipants ?? activeSession?.participants ?? []).some(
      ({ identity }) =>
        identity.type !== "agent" && !(identity.type === "profile" && identity.id === props.userId),
    ) ||
    [...props.messages, ...(props.pendingInputs ?? []).map((input) => input.message)].some(
      (message) => {
        if (normalizeRoleForGrouping(resolveMessageRole(message)) !== "user") {
          return false;
        }
        const sender = resolveMessageSender(
          asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]),
        );
        return Boolean(
          sender && !(sender.identity?.type === "profile" && sender.identity.id === props.userId),
        );
      },
    );
  // The session row counts every person who spoke, including rows not loaded yet.
  // Grouping adds the loaded senders with the same keys, so one person counts once.
  const sessionPeople = new Set(
    [
      activeSession?.owner?.actor.identity,
      ...(activeSession?.expandedParticipants ?? activeSession?.participants ?? []).map(
        ({ identity }) => identity,
      ),
    ].flatMap((identity) =>
      identity && identity.type !== "agent" ? [sessionParticipantIdentityKey(identity)] : [],
    ),
  );
  return { showOwnSenderName, sessionPeople };
}

export function isTranscriptGlobalAlias(
  props: Pick<ChatThreadProps, "sessionHost" | "sessionKey">,
): boolean {
  const sessionHost = props.sessionHost ?? null;
  // Global-alias routing ignores the capped session list, which may omit the
  // canonical row. The scope gate keeps per-sender main threads direct.
  const isGlobalAliasKey =
    parseAgentSessionKey(props.sessionKey)?.rest === "global" ||
    (sessionHost !== null &&
      isUiGlobalScopeConfigured(sessionHost) &&
      resolveUiGlobalAliasAgentId(sessionHost, props.sessionKey) !== null);
  return isGlobalAliasKey;
}

export function resolveTranscriptAvatarPlacement(
  props: Pick<ChatThreadProps, "selectedSession" | "sessionKey" | "userId">,
  chatItems: ReturnType<typeof buildCachedChatItems>,
  isGlobalAliasKey: boolean,
): { isDirectThread: boolean; avatarPlacement: "none" | "footer" | "gutter" } {
  const activeSession = props.selectedSession;
  // 1:1 exchanges do not need an avatar gutter; group threads keep it to identify
  // multiple voices. The capped sessions list may omit the selected row, so absent
  // or unknown rows classify by key, with global aliases taking precedence.
  // senderLabels are not a signal: gateway sanitization also labels 1:1 channel DMs.
  const rowKind = activeSession?.kind;
  const sessionKind =
    rowKind && rowKind !== "unknown"
      ? rowKind
      : isGlobalAliasKey
        ? "global"
        : classifySessionKind(props.sessionKey);
  // Only agent-solo kinds qualify. Global sessions aggregate inbound contexts,
  // including groups/channels; identity-resolving gateways also share sessions
  // between people, so both keep avatars. A forwarded cross-session message adds
  // another voice to a direct exchange and restores identity chrome.
  const hasForwardedGroups = chatItems.some(
    (item) => item.kind === "group" && hasForwardedSource(item),
  );
  const defaultAvatarPlacement = resolveChatDefaultAvatarPlacement(
    (sessionKind === "direct" || sessionKind === "cron" || sessionKind === "spawn-child") &&
      !hasForwardedGroups,
    props.userId,
  );
  const isDirectThread = defaultAvatarPlacement === "footer";
  // Subagent sessions omit avatars; direct chats use the footer, others the gutter.
  const avatarPlacement =
    activeSession?.classification === "subagent" || isSubagentSessionKey(props.sessionKey)
      ? "none"
      : defaultAvatarPlacement;
  return { isDirectThread, avatarPlacement };
}
