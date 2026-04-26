import { resolveConfiguredAcpBindingRecord } from "../acp/persistent-bindings.resolve.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getSessionBindingService,
  type SessionBindingService,
} from "../infra/outbound/session-binding-service.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";

export type TelegramTopicStatusContext = {
  OriginatingChannel?: string;
  Provider?: string;
  Surface?: string;
  OriginatingTo?: string;
  To?: string;
  AccountId?: string;
  MessageThreadId?: string | number;
};

type StatusRoutingLineDeps = {
  resolveConfiguredBinding?: typeof resolveConfiguredAcpBindingRecord;
  sessionBindingService?: Pick<SessionBindingService, "resolveByConversation">;
};

function parseTelegramChatIdFromTarget(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(?:telegram:)?(?:(?:group|channel|direct):)?(-?\d+)(?::topic:\d+)?$/i.exec(
    trimmed,
  );
  return match?.[1];
}

export function buildTelegramTopicStatusLines(
  params: {
    cfg: OpenClawConfig;
    context?: TelegramTopicStatusContext;
    commandTo?: string;
    sessionEntry?: SessionEntry;
  },
  deps: StatusRoutingLineDeps = {},
): string[] {
  const context = params.context;
  const channel = normalizeMessageChannel(
    typeof context?.OriginatingChannel === "string"
      ? context.OriginatingChannel
      : (context?.Surface ?? context?.Provider),
  );
  if (channel !== "telegram") {
    return [];
  }

  const rawThreadId =
    context?.MessageThreadId != null ? String(context.MessageThreadId).trim() : "";
  if (!/^\d+$/.test(rawThreadId)) {
    return [];
  }

  const parentConversationId =
    parseTelegramChatIdFromTarget(context?.OriginatingTo) ??
    parseTelegramChatIdFromTarget(params.commandTo) ??
    parseTelegramChatIdFromTarget(context?.To);
  if (!parentConversationId) {
    return [];
  }

  const conversationId = `${parentConversationId}:topic:${rawThreadId}`;
  const accountId = context?.AccountId?.trim() || "default";
  const resolveConfiguredBinding =
    deps.resolveConfiguredBinding ?? resolveConfiguredAcpBindingRecord;
  const sessionBindingService = deps.sessionBindingService ?? getSessionBindingService();
  const configuredBinding = resolveConfiguredBinding({
    cfg: params.cfg,
    channel: "telegram",
    accountId,
    conversationId,
    parentConversationId,
  });
  const liveBinding = sessionBindingService.resolveByConversation({
    channel: "telegram",
    accountId,
    conversationId,
    parentConversationId,
  });

  const lines = [
    `📍 Topic: ${conversationId}`,
    `🚚 Delivery: telegram:${parentConversationId} · topic ${rawThreadId}`,
  ];

  const configuredTargetSessionKey = configuredBinding?.record.targetSessionKey?.trim();
  if (configuredBinding && configuredTargetSessionKey) {
    const details = [configuredBinding.spec.mode, configuredBinding.spec.backend]
      .filter(Boolean)
      .join(" · ");
    lines.push(
      `🗂 Configured: ACP${details ? ` (${details})` : ""} -> ${configuredTargetSessionKey}`,
    );
  }

  const liveTargetSessionKey = liveBinding?.targetSessionKey?.trim();
  if (liveBinding && liveTargetSessionKey) {
    const kindLabel =
      liveBinding.targetKind === "subagent" ? "focused subagent" : "focused session";
    lines.push(`🧷 Live: ${kindLabel} (${liveBinding.status}) -> ${liveTargetSessionKey}`);
  }

  if (
    configuredTargetSessionKey &&
    liveTargetSessionKey &&
    configuredTargetSessionKey !== liveTargetSessionKey
  ) {
    lines.push("⚠️ Drift: configured target differs from live binding");
  }

  if (params.sessionEntry?.acp) {
    const identity = params.sessionEntry.acp.identity;
    const acpId = identity?.acpxSessionId ?? identity?.acpxRecordId ?? identity?.agentSessionId;
    const acpBits = [
      params.sessionEntry.acp.backend,
      params.sessionEntry.acp.mode,
      params.sessionEntry.acp.state,
      acpId ? `id=${acpId}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`🛰 ACP: ${acpBits}`);
  }

  return lines;
}
