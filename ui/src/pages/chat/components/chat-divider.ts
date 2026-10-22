import type { GatewaySessionRow } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatSessionArchiveReason } from "../../../lib/sessions/session-archive-reason.ts";

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
