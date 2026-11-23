import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { readRunFailureNotice } from "../../../../src/shared/run-failure-notice.js";
import { readSkillWorkshopChangeNotice } from "../../../../src/shared/skill-workshop-change-notice.js";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../../../../src/shared/transcript-only-openclaw-assistant.js";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { registerChatSystemNoticeEnglish } from "../../i18n/locales/en-chat-system-notice.ts";
import type { ChatItem, NormalizedMessage } from "../../lib/chat/chat-types.ts";
import { userTurnRunId } from "../../lib/chat/history-message-identity.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { optionalBoundaryIdentity } from "./chat-thread-run-identity.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";
import {
  resolveSystemNoticeKind,
  projectSystemNoticeSummary,
  type PendingInputStatus,
} from "./system-notice-kinds.ts";

registerChatSessionEnglish();
registerChatSystemNoticeEnglish();

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
  const project = (item: Extract<ChatItem, { kind: "message" }>): ChatItem | undefined => {
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
    const modelChange = {
      from: `${from.provider}/${from.model}`,
      to: `${selected.provider}/${selected.model}`,
    };
    return {
      kind: "notice",
      key: `model-selection:${item.key}`,
      timestamp: safeNormalizeMessage(item.message)?.timestamp ?? 0,
      icon: "brain",
      label: t("chat.systemNotice.modelChanged", modelChange),
      modelChange,
      text: "",
    };
  };
  /** Everything a later message's notice depends on. */
  const state = () => JSON.stringify([previous, hasConversation]);
  return Object.assign(project, { state });
}

/** Pending custody and persisted history share the same system-turn presentation. */
export function projectChatSystemNotice(
  item: Extract<ChatItem, { kind: "message" }>,
  normalized?: NormalizedMessage | null,
  pending?: {
    status: PendingInputStatus;
    key: string;
    timestamp: number;
    endCause?: ChatPendingInputsPage["items"][number]["endCause"];
    retired?: NonNullable<Extract<ChatItem, { kind: "notice" }>["retiredPendingInput"]>;
  },
): ChatItem[] {
  const raw = asRecord(item.message);
  if (
    raw?.role === "assistant" &&
    raw.provider === "openclaw" &&
    typeof raw.responseId === "string" &&
    raw.responseId.startsWith("github-publication:")
  ) {
    const status = raw.openclawGitHubPublicationStatus;
    const text = extractTextCached(item.message)?.trim() ?? "";
    // Older persisted receipts have the Gateway's response ID but no status field.
    if (
      !text ||
      status === "published" ||
      status === "requested" ||
      status === "publishing" ||
      (status === undefined && text.startsWith("Published "))
    ) {
      return [];
    }
    return [
      {
        kind: "notice",
        key: item.key,
        icon: "gitPullRequest",
        text,
        timestamp: (normalized ?? safeNormalizeMessage(item.message))?.timestamp ?? 0,
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
          modelChange: { from: details.from, to: details.to },
          text: "",
        },
      ];
    }
  }
  const provenance = asRecord(raw?.provenance);
  const agentUpdate = provenance?.kind === "inter_session";
  const cancelled = pending?.status === "cancelled";
  const causeKey =
    cancelled &&
    pending.endCause &&
    Object.hasOwn(
      registerChatSystemNoticeEnglish.catalog.chat.pendingInputs.endCause,
      pending.endCause,
    )
      ? `chat.pendingInputs.endCause.${pending.endCause}`
      : undefined;
  const pendingText =
    pending && pending.status !== "queued" && !(cancelled && pending.endCause === "user-stop")
      ? t(
          causeKey ??
            (agentUpdate && cancelled
              ? "chat.pendingInputs.agentUpdate.cancelled"
              : `chat.pendingInputs.${pending.status}`),
        )
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
  const runError = readRunFailureNotice(item.message, { audience: "desktop" });
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
  if (sourceTool === "restart") {
    return [];
  }
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
  const summaryKey = noticeKind?.summaryKey;
  const text = summaryKey
    ? t(summaryKey)
    : (extractTextCached(item.message)?.replace(/^\[System\] /u, "") ?? "");
  if (!text.trim()) {
    return pendingItems;
  }
  const summary = projectSystemNoticeSummary({
    label: !noticeKind
      ? t("common.system")
      : noticeKind.labelKey
        ? t(noticeKind.labelKey)
        : (pluginName ?? ""),
    text,
    detailed: Boolean(noticeKind?.collapsedBody),
    statusOnly: Boolean(summaryKey),
  });
  return [
    {
      kind: "notice",
      key: item.key,
      icon: noticeKind?.icon ?? "cpu",
      ...(pending ? {} : { systemEvent: "info" as const }),
      label: summary.label,
      ...(noticeKind?.startsTurn === false ? {} : { startsTurn: true }),
      ...(summary.collapsedBody ? { collapsedBody: true } : {}),
      ...(noticeKind?.showTimestamp ? { showTimestamp: true } : {}),
      text: summary.text,
      timestamp: message.timestamp,
      ...optionalBoundaryIdentity(userTurnRunId(item.message)),
    },
    ...pendingItems,
  ];
}
