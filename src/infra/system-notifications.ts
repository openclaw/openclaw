import type { OpenClawConfig } from "../config/config.js";
import type { OutboundSendDeps } from "./outbound/deliver.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import { resolveOutboundTarget } from "./outbound/targets.js";

const SENSITIVE_SYSTEM_NOTIFICATION_RE =
  /(pairing code:|openclaw:\s*access not configured|gateway connected|gateway disconnected|^system:)/i;

function firstAllowFromEntry(entries?: Array<string | number>): string | undefined {
  if (!Array.isArray(entries)) {
    return undefined;
  }
  for (const entry of entries) {
    const normalized = String(entry ?? "").trim();
    if (!normalized || normalized === "*") {
      continue;
    }
    return normalized;
  }
  return undefined;
}

function resolveTelegramAdminTarget(
  cfg: OpenClawConfig,
): { to: string; accountId?: string } | null {
  const telegram = cfg.channels?.telegram;
  if (!telegram) {
    return null;
  }

  const accounts = telegram.accounts ?? {};
  for (const [accountId, account] of Object.entries(accounts)) {
    if (!account || account.enabled === false) {
      continue;
    }
    const to = firstAllowFromEntry(account.allowFrom);
    if (to) {
      return { to, accountId };
    }
  }

  const to = firstAllowFromEntry(telegram.allowFrom);
  if (to) {
    return { to };
  }
  return null;
}

export function isSensitiveSystemNotification(text: string): boolean {
  const trimmed = text.trim();
  return Boolean(trimmed) && SENSITIVE_SYSTEM_NOTIFICATION_RE.test(trimmed);
}

export type CrossAppSystemNotificationReason =
  | "explicit_service_status_request"
  | "no_response_escalation";

function isAllowedCrossAppSystemNotificationReason(
  reason: CrossAppSystemNotificationReason | undefined,
): reason is CrossAppSystemNotificationReason {
  return reason === "explicit_service_status_request" || reason === "no_response_escalation";
}

/**
 * Sends sensitive system notifications to Telegram admin only.
 * Returns false when Telegram admin delivery is not configured.
 */
export async function sendSystemNotificationToTelegramAdmin(params: {
  cfg: OpenClawConfig;
  text: string;
  reason?: CrossAppSystemNotificationReason;
  deps?: OutboundSendDeps;
}): Promise<boolean> {
  if (!isAllowedCrossAppSystemNotificationReason(params.reason)) {
    return false;
  }
  if (!isSensitiveSystemNotification(params.text)) {
    return false;
  }
  const target = resolveTelegramAdminTarget(params.cfg);
  if (!target) {
    return false;
  }
  const resolved = resolveOutboundTarget({
    channel: "telegram",
    to: target.to,
    cfg: params.cfg,
    accountId: target.accountId,
    mode: "explicit",
  });
  if (!resolved.ok) {
    return false;
  }
  await deliverOutboundPayloads({
    cfg: params.cfg,
    channel: "telegram",
    to: resolved.to,
    accountId: target.accountId,
    payloads: [{ text: params.text }],
    deps: params.deps,
    bestEffort: true,
  });
  return true;
}
