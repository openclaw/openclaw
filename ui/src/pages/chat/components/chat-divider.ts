import type { GatewaySessionRow } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatSessionArchiveReason } from "../../../lib/sessions/session-archive-reason.ts";
import { solidContent } from "../../../lit/solid-content.tsx";
import { ChatDivider, ChatNotice, type ChatNoticeRecovery } from "./chat-divider.tsx";

export function buildChatArchiveNotice(activeSession: GatewaySessionRow | null | undefined) {
  const archiveActor = activeSession?.archivedBy;
  const archiveLabel = archiveActor?.id
    ? t("sessionsView.archivedBy", { name: archiveActor.label ?? archiveActor.id })
    : activeSession?.archiveReason
      ? formatSessionArchiveReason(activeSession.archiveReason)
      : undefined;
  return activeSession?.archived && activeSession.archivedAt !== undefined && archiveLabel
    ? ({
        kind: "notice",
        key: `archive:${activeSession.sessionId ?? activeSession.key}:${activeSession.archivedAt}`,
        label: archiveLabel,
        text: "",
        timestamp: activeSession.archivedAt,
      } satisfies Extract<ChatItem, { kind: "notice" }>)
    : undefined;
}

export function renderChatDivider(item: Extract<ChatItem, { kind: "divider" }>) {
  return solidContent(ChatDivider, { item });
}

export function renderChatNotice(
  item: Extract<ChatItem, { kind: "notice" }>,
  onPermissionRetry?: (message: string) => void,
  recovery?: ChatNoticeRecovery,
) {
  return solidContent(ChatNotice, { item, onPermissionRetry, recovery });
}
