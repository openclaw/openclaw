import type { OpenClawConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { runMessageAction } from "../infra/outbound/message-action-runner.js";
import { normalizeSessionDeliveryFields } from "../utils/delivery-context.js";

export type RestartNoticeReason = "config.apply" | "config.patch" | "update.run";

function resolveRestartNoticeText(params: {
  delayMs?: number;
  reason: RestartNoticeReason;
}): string {
  const delayMs =
    typeof params.delayMs === "number" && Number.isFinite(params.delayMs) ? params.delayMs : 0;
  const etaSec = Math.max(1, Math.round(Math.max(0, delayMs) / 1000) + 8);
  return `Restarting gateway now (back in ~${etaSec}s)…`;
}

export async function sendGatewayRestartNotice(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  reason: RestartNoticeReason;
  delayMs?: number;
}): Promise<boolean> {
  if (params.cfg.gateway?.restartNotice?.enabled !== true) {
    return false;
  }
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: "main" });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return false;
  }
  const deliveryFields = normalizeSessionDeliveryFields(entry);
  const channel = deliveryFields.lastChannel;
  const target = deliveryFields.lastTo;
  if (!channel || !target) {
    return false;
  }

  const message = resolveRestartNoticeText({ delayMs: params.delayMs, reason: params.reason });

  try {
    await runMessageAction({
      cfg: params.cfg,
      action: "send",
      params: {
        channel,
        target,
        accountId: deliveryFields.lastAccountId,
        threadId: deliveryFields.lastThreadId ? String(deliveryFields.lastThreadId) : undefined,
        message,
      },
      defaultAccountId: deliveryFields.lastAccountId,
      // Gateway-side send; no toolContext inference needed.
      gateway: {
        clientName: "gateway",
        clientDisplayName: "gateway",
        mode: "backend",
      },
      dryRun: false,
    });
    return true;
  } catch {
    return false;
  }
}
