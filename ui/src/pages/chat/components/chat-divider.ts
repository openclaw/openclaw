import type { GatewaySessionRow } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatSessionArchiveReason } from "../../../lib/sessions/session-archive-reason.ts";
import { currentResetBoundaryId } from "../chat-progress.ts";
import type { ChatDivider } from "./chat-divider.tsx";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";

export function buildChatArchiveNotice(
  activeSession:
    | Pick<
        GatewaySessionRow,
        "key" | "sessionId" | "archived" | "archivedAt" | "archivedBy" | "archiveReason"
      >
    | null
    | undefined,
) {
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

export function projectChatDivider(
  item: Extract<ChatItem, { kind: "divider" }>,
  props: Pick<ChatThreadProps, "messages" | "onUndoReset" | "undoResetPending">,
): { kind: "divider" } & Parameters<typeof ChatDivider>[0] {
  return {
    kind: "divider",
    item,
    onUndoReset:
      item.boundaryId === currentResetBoundaryId(props.messages) ? props.onUndoReset : undefined,
    undoResetPending: props.undoResetPending,
  };
}
