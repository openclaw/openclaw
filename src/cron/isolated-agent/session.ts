import crypto from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath, type SessionEntry } from "../../config/sessions.js";

export function resolveCronSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  nowMs: number;
  agentId: string;
}) {
  const sessionCfg = params.cfg.session;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  const sessionId = crypto.randomUUID();
  const systemSent = false;

  const sessionEntry: SessionEntry = {
    // Preserve existing per-session overrides even when rolling to a new sessionId.
    ...entry,
    // Always update these core fields
    sessionId,
    updatedAt: params.nowMs,
    systemSent,
  };
  return { storePath, store, sessionEntry, systemSent, isNewSession: true };
}
