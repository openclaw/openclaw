import crypto from "node:crypto";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
} from "../../config/sessions/reset.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";

/**
 * Returns true when the persisted deliveryContext appears to have been written by a
 * system event (heartbeat / cron-event) rather than a real user interaction.
 * A heartbeat run uses the literal string "heartbeat" as the delivery `to` target,
 * and if that value is written into the shared session store it poisons the routing
 * state for subsequent isolated cron announce deliveries.
 * See: https://github.com/openclaw/openclaw/issues/63733
 */
function isSystemDeliveryContext(
  ctx: { to?: string | null } | null | undefined,
): boolean {
  if (!ctx || typeof ctx !== "object") {
    return false;
  }
  const to = typeof ctx.to === "string" ? ctx.to.trim() : "";
  // The heartbeat delivery target is the literal string "heartbeat" (no prefix).
  return to === "heartbeat" || to === "cron-event" || to === "exec-event";
}

export function resolveCronSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  nowMs: number;
  agentId: string;
  forceNew?: boolean;
}) {
  const sessionCfg = params.cfg.session;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];

  // Check if we can reuse an existing session
  let sessionId: string;
  let isNewSession: boolean;
  let systemSent: boolean;

  if (!params.forceNew && entry?.sessionId) {
    // Evaluate freshness using the configured reset policy
    // Cron/webhook sessions use "direct" reset type (1:1 conversation style)
    const resetPolicy = resolveSessionResetPolicy({
      sessionCfg,
      resetType: "direct",
    });
    const freshness = evaluateSessionFreshness({
      updatedAt: entry.updatedAt,
      now: params.nowMs,
      policy: resetPolicy,
    });

    if (freshness.fresh) {
      // Reuse existing session
      sessionId = entry.sessionId;
      isNewSession = false;
      systemSent = entry.systemSent ?? false;
    } else {
      // Session expired, create new
      sessionId = crypto.randomUUID();
      isNewSession = true;
      systemSent = false;
    }
  } else {
    // No existing session or forced new
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
  }

  clearBootstrapSnapshotOnSessionRollover({
    sessionKey: params.sessionKey,
    previousSessionId: isNewSession ? entry?.sessionId : undefined,
  });

  const sessionEntry: SessionEntry = {
    // Preserve existing per-session overrides even when rolling to a new sessionId.
    ...entry,
    // Always update these core fields
    sessionId,
    updatedAt: params.nowMs,
    systemSent,
    // When starting a fresh session (forceNew / isolated), clear delivery routing
    // state inherited from prior sessions. Without this, lastThreadId leaks into
    // the new session and causes announce-mode cron deliveries to post as thread
    // replies instead of channel top-level messages.
    // deliveryContext must also be cleared because normalizeSessionEntryDelivery
    // repopulates lastThreadId from deliveryContext.threadId on store writes.
    // When the persisted delivery context appears to have been written by a system
    // event (e.g. a heartbeat run wrote {to: "heartbeat"} into the session store
    // that this isolated cron job shares), clear it unconditionally to prevent
    // poisoned routing. See: https://github.com/openclaw/openclaw/issues/63733
    ...(isNewSession || isSystemDeliveryContext(entry?.deliveryContext) ? {
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
      lastThreadId: undefined,
      deliveryContext: undefined,
    } : {}),
  };
  return { storePath, store, sessionEntry, systemSent, isNewSession };
}
