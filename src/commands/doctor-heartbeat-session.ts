import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveMainScopedEventSessionKey } from "../infra/event-session-routing.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import type { HeartbeatConfig } from "./doctor-heartbeat-legacy.js";

export function resolveLegacyHeartbeatSessionKey(
  cfg: OpenClawConfig,
  agentId: string,
  heartbeat?: HeartbeatConfig,
  forcedSessionKey?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const sessionCfg = cfg.session;
  const resolvedAgentId = normalizeAgentId(agentId);
  const storePath = resolveSessionStorePathCore(sessionCfg?.store, {
    agentId: resolvedAgentId,
    env,
  });
  if (sessionCfg?.scope === "global") {
    const target = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: resolvedAgentId,
      defaultAgentId: cfg.agents?.defaults?.sessionStore?.agentId,
      env,
    });
    // The literal global row belongs to the physical owner of a shared store.
    return {
      sessionKey:
        target.shared && target.agentId !== resolvedAgentId
          ? toAgentStoreSessionKey({ agentId: resolvedAgentId, requestKey: "global" })
          : "global",
      storePath,
    };
  }

  const heartbeatSession = heartbeat?.session;
  const mainSessionKey =
    cfg.session?.scope === "global"
      ? "global"
      : resolveAgentMainSessionKey({ cfg, agentId: resolvedAgentId });
  const selectSession = (sessionKey = mainSessionKey) => ({
    sessionKey,
    storePath,
  });
  if (cfg.session?.scope === "global") {
    return selectSession();
  }

  const resolveCandidate = (requestKey: string) => {
    const candidate = toAgentStoreSessionKey({
      agentId: resolvedAgentId,
      requestKey,
      mainKey: cfg.session?.mainKey,
    });
    if (isSubagentSessionKey(candidate)) {
      return undefined;
    }
    const canonical = canonicalizeMainSessionAlias({
      cfg,
      agentId: resolvedAgentId,
      sessionKey: candidate,
    });
    return canonical !== "global" &&
      !isSubagentSessionKey(canonical) &&
      resolveAgentIdFromSessionKey(canonical) === resolvedAgentId
      ? canonical
      : undefined;
  };

  // Never route heartbeats to subagent sessions, regardless of entry path.
  const forced = forcedSessionKey?.trim();
  if (forced && isSubagentSessionKey(forced)) {
    return selectSession(mainSessionKey);
  }
  const forcedCanonical = forced ? resolveCandidate(forced) : undefined;
  if (forcedCanonical) {
    return selectSession(
      resolveMainScopedEventSessionKey({
        cfg,
        sessionKey: forcedCanonical,
        agentId: resolvedAgentId,
      }) ?? forcedCanonical,
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

export function resolveLegacyHeartbeatSession(
  cfg: OpenClawConfig,
  agentId: string,
  heartbeat?: HeartbeatConfig,
  forcedSessionKey?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const resolved = resolveLegacyHeartbeatSessionKey(cfg, agentId, heartbeat, forcedSessionKey, env);
  return {
    ...resolved,
    entry: loadSessionEntryReadOnly({
      agentId,
      storePath: resolved.storePath,
      sessionKey: resolved.sessionKey,
      env,
    }),
  };
}
