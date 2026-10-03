import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveMainScopedEventSessionKey } from "../infra/event-session-routing.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import type { HeartbeatConfig } from "./doctor-heartbeat-legacy.js";

export function resolveHeartbeatSessionKey(
  cfg: OpenClawConfig,
  agentId: string,
  heartbeat?: HeartbeatConfig,
  forcedSessionKey?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const resolvedAgentId = normalizeAgentId(agentId);
  const mainSessionKey =
    scope === "global" ? "global" : resolveAgentMainSessionKey({ cfg, agentId: resolvedAgentId });
  const storePath = resolveSessionStorePathCore(sessionCfg?.store, {
    // A literal `global` row is global only inside the selected agent's store.
    // Falling back here leaks the default agent's route into secondary heartbeats.
    agentId: resolvedAgentId,
    env,
  });
  const mainSession = (suppressOriginatingContext = false) => ({
    sessionKey: mainSessionKey,
    storePath,
    suppressOriginatingContext,
  });

  if (scope === "global") {
    return mainSession();
  }

  // Guard: never route heartbeats to subagent sessions, regardless of entry path.
  const forced = forcedSessionKey?.trim();
  if (forced && isSubagentSessionKey(forced)) {
    return mainSession(true);
  }

  if (forced && !isSubagentSessionKey(forced)) {
    const forcedCandidate = toAgentStoreSessionKey({
      agentId: resolvedAgentId,
      requestKey: forced,
      mainKey: cfg.session?.mainKey,
    });
    if (!isSubagentSessionKey(forcedCandidate)) {
      const forcedCanonical = canonicalizeMainSessionAlias({
        cfg,
        agentId: resolvedAgentId,
        sessionKey: forcedCandidate,
      });
      if (forcedCanonical !== "global" && !isSubagentSessionKey(forcedCanonical)) {
        const sessionAgentId = resolveAgentIdFromSessionKey(forcedCanonical);
        if (sessionAgentId === normalizeAgentId(resolvedAgentId)) {
          const routedSessionKey =
            resolveMainScopedEventSessionKey({
              cfg,
              sessionKey: forcedCanonical,
              agentId: resolvedAgentId,
            }) ?? forcedCanonical;
          return {
            sessionKey: routedSessionKey,
            storePath,
            suppressOriginatingContext: false,
          };
        }
      }
    }
  }

  const trimmed = heartbeat?.session?.trim() ?? "";
  if (!trimmed || isSubagentSessionKey(trimmed)) {
    return mainSession();
  }

  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (normalized === "main" || normalized === "global") {
    return mainSession();
  }

  const candidate = toAgentStoreSessionKey({
    agentId: resolvedAgentId,
    requestKey: trimmed,
    mainKey: cfg.session?.mainKey,
  });
  if (isSubagentSessionKey(candidate)) {
    return mainSession();
  }
  const canonical = canonicalizeMainSessionAlias({
    cfg,
    agentId: resolvedAgentId,
    sessionKey: candidate,
  });
  if (canonical !== "global" && !isSubagentSessionKey(canonical)) {
    const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
    if (sessionAgentId === normalizeAgentId(resolvedAgentId)) {
      return {
        sessionKey: canonical,
        storePath,
        suppressOriginatingContext: false,
      };
    }
  }

  return mainSession();
}

export function resolveHeartbeatSession(
  cfg: OpenClawConfig,
  agentId: string,
  heartbeat?: HeartbeatConfig,
  forcedSessionKey?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const resolved = resolveHeartbeatSessionKey(cfg, agentId, heartbeat, forcedSessionKey, env);
  return {
    ...resolved,
    entry: loadSessionEntryReadOnly({
      storePath: resolved.storePath,
      sessionKey: resolved.sessionKey,
      env,
    }),
  };
}
