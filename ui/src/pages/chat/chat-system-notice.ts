import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import type { ChatItem, NormalizedMessage } from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { userTurnRunId } from "./chat-thread-items.ts";
import { optionalBoundaryIdentity } from "./chat-thread-run-identity.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { resolveSystemNoticeKind } from "./system-notice-kinds.ts";

/** Pending custody and persisted history share the same system-turn presentation. */
export function projectChatSystemNotice(
  item: Extract<ChatItem, { kind: "message" }>,
  normalized?: NormalizedMessage | null,
): ChatItem | undefined {
  const provenance = asRecord(asRecord(item.message)?.provenance);
  if (provenance?.kind !== "internal_system") {
    return item;
  }
  const message = normalized ?? safeNormalizeMessage(item.message);
  if (!message || normalizeRoleForGrouping(message.role) !== "user") {
    return item;
  }
  const noticeKind = resolveSystemNoticeKind(
    typeof provenance.sourceTool === "string" ? provenance.sourceTool : undefined,
  );
  const text = noticeKind?.summaryKey
    ? t(noticeKind.summaryKey)
    : extractTextCached(item.message)?.replace(/^\[System\] /u, "");
  if (!text?.trim()) {
    return undefined;
  }
  return {
    kind: "notice",
    key: item.key,
    icon: noticeKind?.icon ?? "cpu",
    label: noticeKind ? t(noticeKind.labelKey) : t("common.system"),
    ...(noticeKind?.startsTurn === false ? {} : { startsTurn: true }),
    ...(noticeKind?.collapsedBody ? { collapsedBody: true } : {}),
    text,
    timestamp: message.timestamp,
    ...optionalBoundaryIdentity(userTurnRunId(item.message)),
  };
}
