import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveLocalUserName } from "../../../app/user-identity.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { messageClientSourcesLabel } from "../../../lib/chat/message-client-source.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { workspaceResultConflictFromTranscript } from "../workspace-conflict.ts";

registerChatSessionEnglish();

export function isOwnSenderGroup(
  group: Pick<MessageGroup, "sender">,
  viewer: { userId?: string | null; userSenderId?: string | null },
): boolean {
  const sender = group.sender;
  if (sender?.identity) {
    return sender.identity.type === "profile" && sender.identity.id === viewer.userId;
  }
  // Tailscale or trusted-proxy access without a profile stamps only the authenticated id.
  return Boolean(viewer.userSenderId && sender?.id === viewer.userSenderId);
}

export function isSourceOnlyUserGroup(
  group: Pick<MessageGroup, "role" | "sender" | "senderLabel" | "sourceClients">,
): boolean {
  return (
    normalizeRoleForGrouping(group.role) === "user" &&
    Boolean(group.sourceClients?.length) &&
    !group.sender &&
    !group.senderLabel?.trim()
  );
}

export function resolveMessageGroupSenderLabel(
  group: Pick<MessageGroup, "role" | "sender" | "senderLabel" | "sourceClients"> & {
    messages: ReadonlyArray<{ message: unknown }>;
  },
  opts: {
    assistantName?: string;
    userId?: string | null;
    userSenderId?: string | null;
    userName?: string | null;
  },
): string {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  if (isSourceOnlyUserGroup(group)) {
    return messageClientSourcesLabel(group.sourceClients ?? []);
  }
  if (normalizedRole === "custom") {
    const isError = group.messages.every(({ message }) => {
      const customType = asNullableRecord(message)?.customType;
      return (
        customType === "run-failed-before-reply" || customType === "cloud-workspace-recovery-failed"
      );
    });
    if (isError) {
      const isContention = group.messages.every(({ message }) => {
        const entry = asNullableRecord(message);
        return (
          entry?.customType === "run-failed-before-reply" &&
          asNullableRecord(entry.details)?.errorKind === "state_contention"
        );
      });
      return t(isContention ? "common.system" : "chat.messages.errorSender");
    }
    return group.messages.every(({ message }) => workspaceResultConflictFromTranscript(message))
      ? t("chat.workspaceConflict.eventSender")
      : t("common.system");
  }
  const resolvedUserName = resolveLocalUserName({ name: opts.userName });
  const userLabel = group.senderLabel?.trim();
  return normalizedRole === "user"
    ? isOwnSenderGroup(group, opts)
      ? resolvedUserName
      : (userLabel ?? t("chat.messages.unattributedSender"))
    : normalizedRole === "assistant"
      ? (userLabel ?? opts.assistantName ?? "Assistant")
      : normalizedRole === "tool"
        ? t("chat.messages.toolSender")
        : normalizedRole;
}
