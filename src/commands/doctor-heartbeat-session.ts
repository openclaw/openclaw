import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatSessionTarget } from "../infra/heartbeat-session-target.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../routing/session-key.js";
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
      suppressOriginatingContext: false,
    };
  }

  return resolveHeartbeatSessionTarget(
    cfg,
    resolvedAgentId,
    storePath,
    heartbeat?.session,
    forcedSessionKey,
  );
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
