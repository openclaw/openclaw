import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { getAgentRunContext, registerAgentRunContext } from "../infra/agent-events.js";

export function resolveSessionKeyForRun(runId: string) {
  const cached = getAgentRunContext(runId)?.sessionKey;
  if (cached) return cached;
  const cfg = loadConfig();
  const storePath = resolveStorePath(cfg.session?.store);
  const store = loadSessionStore(storePath);
  const found = Object.entries(store).find(([, entry]) => entry?.sessionId === runId);
  const sessionKey = found?.[0];
  if (sessionKey) {
    registerAgentRunContext(runId, { sessionKey });
  }
  return sessionKey;
}
