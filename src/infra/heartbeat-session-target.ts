import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isSubagentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { resolveMainScopedEventSessionKey } from "./event-session-routing.js";

/** Routing shared by live heartbeats and Doctor's legacy heartbeat migration. */
export function resolveHeartbeatSessionTarget(
  cfg: OpenClawConfig,
  agentId: string,
  storePath: string,
  heartbeatSession: string | undefined,
  forcedSessionKey?: string,
) {
  const mainSessionKey =
    cfg.session?.scope === "global" ? "global" : resolveAgentMainSessionKey({ cfg, agentId });
  const selectSession = (sessionKey = mainSessionKey, suppressOriginatingContext = false) => ({
    sessionKey,
    storePath,
    suppressOriginatingContext,
  });
  if (cfg.session?.scope === "global") {
    return selectSession();
  }

  const resolveCandidate = (requestKey: string) => {
    const candidate = toAgentStoreSessionKey({
      agentId,
      requestKey,
      mainKey: cfg.session?.mainKey,
    });
    if (isSubagentSessionKey(candidate)) {
      return undefined;
    }
    const canonical = canonicalizeMainSessionAlias({ cfg, agentId, sessionKey: candidate });
    return canonical !== "global" &&
      !isSubagentSessionKey(canonical) &&
      resolveAgentIdFromSessionKey(canonical) === agentId
      ? canonical
      : undefined;
  };

  // Never route heartbeats to subagent sessions, regardless of entry path.
  const forced = forcedSessionKey?.trim();
  if (forced && isSubagentSessionKey(forced)) {
    return selectSession(mainSessionKey, true);
  }
  const forcedCanonical = forced ? resolveCandidate(forced) : undefined;
  if (forcedCanonical) {
    return selectSession(
      resolveMainScopedEventSessionKey({ cfg, sessionKey: forcedCanonical, agentId }) ??
        forcedCanonical,
    );
  }

  const trimmed = heartbeatSession?.trim() ?? "";
  if (!trimmed || isSubagentSessionKey(trimmed)) {
    return selectSession();
  }
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (normalized === "main" || normalized === "global") {
    return selectSession();
  }
  return selectSession(resolveCandidate(trimmed) || mainSessionKey);
}
