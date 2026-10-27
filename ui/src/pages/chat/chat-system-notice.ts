import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { readRunFailureNotice } from "../../../../src/shared/run-failure-notice.js";
import { readSkillWorkshopChangeNotice } from "../../../../src/shared/skill-workshop-change-notice.js";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../../../../src/shared/transcript-only-openclaw-assistant.js";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import type { ChatItem, NormalizedMessage } from "../../lib/chat/chat-types.ts";
import { userTurnRunId } from "../../lib/chat/history-message-identity.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { optionalBoundaryIdentity } from "./chat-thread-run-identity.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { resolveSystemNoticeKind, type PendingInputStatus } from "./system-notice-kinds.ts";

registerChatSessionEnglish();

type SubmittedModel = { provider: string; model: string };

function readSubmittedModel(value: unknown): SubmittedModel | undefined {
  const model = asRecord(value);
  return typeof model?.provider === "string" &&
    model.provider.length > 0 &&
    typeof model.model === "string" &&
    model.model.length > 0
    ? { provider: model.provider, model: model.model }
    : undefined;
}

/** Compare committed inputs, not draft picker changes or model fallback responses. */
export function createSubmittedModelNoticeProjector() {
  let previous: SubmittedModel | undefined;
  let hasConversation = false;
  return (item: Extract<ChatItem, { kind: "message" }>): ChatItem | undefined => {
    const raw = asRecord(item.message);
    const metadata = asRecord(raw?.["__openclaw"]);
    if (metadata?.kind === "reset") {
      previous = undefined;
      hasConversation = false;
      return undefined;
    }
    if (
      !raw ||
      raw.display === false ||
      raw.excludeFromContext === true ||
      metadata?.lateMedia === true
    ) {
      return undefined;
    }
    if (raw.role === "assistant") {
      hasConversation = true;
      return undefined;
    }
    if (raw.role !== "user") {
      return undefined;
    }
    const selection = asRecord(metadata?.modelSelection);
    const selected = readSubmittedModel(selection);
    if (!selected) {
      hasConversation = true;
      return undefined;
    }
    // A page beginning mid-queue has no preceding selection to compare safely.
    const from =
      previous ?? (hasConversation ? readSubmittedModel(selection?.previous) : undefined);
    previous = selected;
    hasConversation = true;
    if (!from || (from.provider === selected.provider && from.model === selected.model)) {
      return undefined;
    }
    return {
      kind: "notice",
      key: `model-selection:${item.key}`,
      timestamp: safeNormalizeMessage(item.message)?.timestamp ?? 0,
      icon: "brain",
      label: t("chat.systemNotice.modelChanged", {
        from: `${from.provider}/${from.model}`,
        to: `${selected.provider}/${selected.model}`,
      }),
      text: "",
    };
  };
}

/** Pending custody and persisted history share the same system-turn presentation. */
export function projectChatSystemNotice(
  item: Extract<ChatItem, { kind: "message" }>,
  normalized?: NormalizedMessage | null,
  pending?: {
    status: PendingInputStatus;
    key: string;
    timestamp: number;
    retired?: NonNullable<Extract<ChatItem, { kind: "notice" }>["retiredPendingInput"]>;
  },
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
  if (raw?.role === "custom" && raw.customType === "session-model-change") {
    const details = asRecord(raw.details);
    if (typeof details?.from === "string" && typeof details.to === "string") {
      return [
        {
          kind: "notice",
          key: item.key,
          timestamp: (normalized ?? safeNormalizeMessage(item.message))?.timestamp ?? 0,
          icon: "brain",
          label: t("chat.systemNotice.modelChanged", { from: details.from, to: details.to }),
          text: "",
        },
      ];
    }
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
            ...(pending.retired ? { retiredPendingInput: pending.retired } : {}),
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
  // Persisted notices from before structured skill markers still carry the
  // Workshop writer's idempotency key. Keep their original text, not a guessed
  // skill/Undo payload, outside assistant answer ownership and Worked rollups.
  const noticeKey = raw?.idempotencyKey ?? asRecord(raw?.["__openclaw"])?.idempotencyKey;
  const legacySkillNotice =
    isOpenClawDeliveryMirrorAssistantMessage(item.message) &&
    typeof noticeKey === "string" &&
    noticeKey.startsWith("skill-workshop-notice:") &&
    noticeKey.length > "skill-workshop-notice:".length;
  const skillNoticeMessage =
    (skillChanges || legacySkillNotice) && (normalized ?? safeNormalizeMessage(item.message));
  if (skillNoticeMessage) {
    const { timestamp } = skillNoticeMessage;
    return [
      {
        kind: "notice",
        key: item.key,
        text: skillChanges ? "" : (extractTextCached(item.message) ?? ""),
        timestamp,
        ...(skillChanges ? { skillChanges } : {}),
      },
      ...pendingItems,
    ];
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
      ...(pendingSummaryKey && pending?.retired ? { retiredPendingInput: pending.retired } : {}),
    },
    ...(pendingSummaryKey ? [] : pendingItems),
  ];
}
