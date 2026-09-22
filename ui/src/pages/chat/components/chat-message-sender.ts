import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveLocalUserName } from "../../../app/user-identity.ts";
import { t } from "../../../i18n/index.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { messageClientSourcesLabel } from "../../../lib/chat/message-client-source.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { workspaceResultConflictFromTranscript } from "../workspace-conflict.ts";

export function isOwnSenderGroup(
  group: Pick<MessageGroup, "sender">,
  userId: string | null | undefined,
): boolean {
  const identity = group.sender?.identity;
  return identity?.type === "profile" && identity.id === userId;
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
  opts: { assistantName?: string; userId?: string | null; userName?: string | null },
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
    ? isOwnSenderGroup(group, opts.userId)
      ? resolvedUserName
      : (userLabel ?? resolvedUserName)
    : normalizedRole === "assistant"
      ? (userLabel ?? opts.assistantName ?? "Assistant")
      : normalizedRole === "tool"
        ? t("chat.messages.toolSender")
        : normalizedRole;
}
