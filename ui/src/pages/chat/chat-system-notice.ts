import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { readRunFailureNotice } from "../../../../src/shared/run-failure-notice.js";
import { readSkillWorkshopChangeNotice } from "../../../../src/shared/skill-workshop-change-notice.js";
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
  const raw = asRecord(item.message);
  if (raw?.role === "custom" && raw.customType === "session-send-recovery-blocked") {
    return [
      {
        kind: "notice",
        key: item.key,
        timestamp: (normalized ?? safeNormalizeMessage(item.message))?.timestamp ?? 0,
        icon: "cpu",
        systemEvent: "delivery-warning",
        text: extractTextCached(item.message) ?? "",
      },
    ];
  }
  const provenance = asRecord(raw?.provenance);
  const agentUpdate = provenance?.kind === "inter_session";
  const pendingText =
    pending && agentUpdate && (pending.status === "cancelled" || pending.status === "interrupted")
      ? t(`chat.pendingInputs.agentUpdate.${pending.status}`)
      : pending && pending.status !== "queued"
        ? t(`chat.pendingInputs.${pending.status}`)
        : undefined;
  const pendingItems: ChatItem[] =
    pending && pendingText
      ? [
          {
            kind: "notice",
            key: pending.key,
            timestamp: pending.timestamp,
            text: pendingText,
          },
        ]
      : [];
  const skillChanges = readSkillWorkshopChangeNotice(item.message);
  const runError = readRunFailureNotice(item.message);
  if (runError) {
    const message = normalized ?? safeNormalizeMessage(item.message);
    return [
      {
        kind: "notice",
        key: item.key,
        text: runError.summary,
        timestamp: message?.timestamp ?? 0,
        runError,
      },
      ...pendingItems,
    ];
  }
  const skillNoticeMessage = skillChanges && (normalized ?? safeNormalizeMessage(item.message));
  if (skillChanges && skillNoticeMessage) {
    const { timestamp } = skillNoticeMessage;
    return [{ kind: "notice", key: item.key, text: "", timestamp, skillChanges }, ...pendingItems];
  }
  if (provenance?.kind !== "internal_system") {
    return [item, ...pendingItems];
  }
  const message = normalized ?? safeNormalizeMessage(item.message);
  if (!message || normalizeRoleForGrouping(message.role) !== "user") {
    return [item, ...pendingItems];
  }
  const sourceTool = typeof provenance.sourceTool === "string" ? provenance.sourceTool : undefined;
  const noticeKind = resolveSystemNoticeKind(sourceTool);
  const pluginSteering = sourceTool?.startsWith("plugin:")
    ? asRecord(asRecord(raw?.["__openclaw"])?.pluginSteering)
    : null;
  const pluginName =
    typeof pluginSteering?.pluginName === "string" && pluginSteering.pluginName.trim()
      ? pluginSteering.pluginName
      : typeof pluginSteering?.pluginId === "string" && pluginSteering.pluginId.trim()
        ? pluginSteering.pluginId
        : sourceTool?.slice("plugin:".length);
  const pendingSummaryKey = pending && noticeKind?.pendingSummaryKeys?.[pending.status];
  const summaryKey = pendingSummaryKey ?? noticeKind?.summaryKey;
  const text =
    summaryKey === null
      ? ""
      : summaryKey
        ? t(summaryKey)
        : (extractTextCached(item.message)?.replace(/^\[System\] /u, "") ?? "");
  if (!text.trim() && summaryKey !== null) {
    return pendingItems;
  }
  return [
    {
      kind: "notice",
      key: item.key,
      icon: noticeKind?.icon ?? "cpu",
      ...(pending ? {} : { systemEvent: "info" as const }),
      label: noticeKind ? t(noticeKind.labelKey, { plugin: pluginName ?? "" }) : t("common.system"),
      ...(noticeKind?.startsTurn === false ? {} : { startsTurn: true }),
      ...(noticeKind?.collapsedBody ? { collapsedBody: true } : {}),
      ...(noticeKind?.showTimestamp ? { showTimestamp: true } : {}),
      text,
      timestamp: message.timestamp,
      ...optionalBoundaryIdentity(userTurnRunId(item.message)),
    },
    ...(pendingSummaryKey ? [] : pendingItems),
  ];
}
