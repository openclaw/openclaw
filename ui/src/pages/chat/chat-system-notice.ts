import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import type { ChatItem, NormalizedMessage } from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { userTurnRunId } from "./chat-thread-items.ts";
import { optionalBoundaryIdentity } from "./chat-thread-run-identity.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { resolveSystemNoticeKind, type PendingInputStatus } from "./system-notice-kinds.ts";

/** Pending custody and persisted history share the same system-turn presentation. */
export function projectChatSystemNotice(
  item: Extract<ChatItem, { kind: "message" }>,
  normalized?: NormalizedMessage | null,
  pending?: { status: PendingInputStatus; key: string; timestamp: number },
): ChatItem[] {
  const pendingItems: ChatItem[] = pending
    ? [
        {
          kind: "notice",
          key: pending.key,
          timestamp: pending.timestamp,
          text: t(`chat.pendingInputs.${pending.status}`),
        },
      ]
    : [];
  const provenance = asRecord(asRecord(item.message)?.provenance);
  if (provenance?.kind !== "internal_system") {
    return [item, ...pendingItems];
  }
  const message = normalized ?? safeNormalizeMessage(item.message);
  if (!message || normalizeRoleForGrouping(message.role) !== "user") {
    return [item, ...pendingItems];
  }
  const noticeKind = resolveSystemNoticeKind(
    typeof provenance.sourceTool === "string" ? provenance.sourceTool : undefined,
  );
  const pendingSummaryKey = pending && noticeKind?.pendingSummaryKeys?.[pending.status];
  const summaryKey = pendingSummaryKey ?? noticeKind?.summaryKey;
  const text = summaryKey
    ? t(summaryKey)
    : extractTextCached(item.message)?.replace(/^\[System\] /u, "");
  if (!text?.trim()) {
    return pendingItems;
  }
  return [
    {
      kind: "notice",
      key: item.key,
      icon: noticeKind?.icon ?? "cpu",
      label: noticeKind ? t(noticeKind.labelKey) : t("common.system"),
      ...(noticeKind?.startsTurn === false ? {} : { startsTurn: true }),
      ...(noticeKind?.collapsedBody ? { collapsedBody: true } : {}),
      text,
      timestamp: message.timestamp,
      ...optionalBoundaryIdentity(userTurnRunId(item.message)),
    },
    ...(pendingSummaryKey ? [] : pendingItems),
  ];
}
