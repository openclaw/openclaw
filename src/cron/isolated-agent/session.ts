import crypto from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import {
  evaluateSessionFreshness,
  loadSessionStore,
  resolveSessionResetPolicy,
  resolveStorePath,
  type SessionEntry,
} from "../../config/sessions.js";

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

  const sessionEntry: SessionEntry = {
    // Preserve existing per-session overrides even when rolling to a new sessionId.
    ...entry,
    // Always update these core fields
    sessionId,
    updatedAt: params.nowMs,
    systemSent,
  };
  return { storePath, store, sessionEntry, systemSent, isNewSession };
}
