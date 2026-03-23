import crypto from "node:crypto";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
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

  clearBootstrapSnapshotOnSessionRollover({
    sessionKey: params.sessionKey,
    previousSessionId: isNewSession ? entry?.sessionId : undefined,
  });

  // Build session entry based on mode:
  // - Isolated mode (forceNew): completely fresh entry, no inherited context
  // - New session (expired): preserve user config, clear routing metadata
  // - Reuse session: preserve everything, clear routing metadata only
  const sessionEntry: SessionEntry = params.forceNew
    ? {
        // Isolated mode: completely fresh entry
        sessionId,
        updatedAt: params.nowMs,
        systemSent,
      }
    : isNewSession
      ? {
          // New session (expired): preserve user config from old entry
          ...entry,
          sessionId,
          updatedAt: params.nowMs,
          systemSent,
          // Clear routing metadata for fresh inference
          lastChannel: undefined,
          lastTo: undefined,
          lastAccountId: undefined,
          lastThreadId: undefined,
          deliveryContext: undefined,
        }
      : {
          // Reuse session: preserve everything, just clear routing
          ...entry,
          sessionId,
          updatedAt: params.nowMs,
          systemSent,
          lastChannel: undefined,
          lastTo: undefined,
          lastAccountId: undefined,
          lastThreadId: undefined,
          deliveryContext: undefined,
        };
  return { storePath, store, sessionEntry, systemSent, isNewSession };
}
