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
  const scope = sessionCfg?.scope ?? "per-sender";
  const resolvedAgentId = normalizeAgentId(agentId);
  const mainSessionKey =
    scope === "global" ? "global" : resolveAgentMainSessionKey({ cfg, agentId: resolvedAgentId });
  const storePath = resolveSessionStorePathCore(sessionCfg?.store, {
    agentId: resolvedAgentId,
    env,
  });
  const mainSession = (suppressOriginatingContext = false) => ({
    sessionKey: mainSessionKey,
    storePath,
    suppressOriginatingContext,
  });

  if (scope === "global") {
    const target = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: resolvedAgentId,
      defaultAgentId: cfg.agents?.defaults?.sessionStore?.agentId,
      env,
    });
    // The literal global row belongs to the physical owner of a shared store.
    return {
      ...mainSession(),
      sessionKey:
        target.shared && target.agentId !== resolvedAgentId
          ? toAgentStoreSessionKey({ agentId: resolvedAgentId, requestKey: "global" })
          : mainSessionKey,
    };
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
      resolveAgentIdFromSessionKey(canonical) === normalizeAgentId(resolvedAgentId)
      ? canonical
      : undefined;
  };

  // Guard: never route heartbeats to subagent sessions, regardless of entry path.
  const forced = forcedSessionKey?.trim();
  if (forced && isSubagentSessionKey(forced)) {
    return mainSession(true);
  }

  const forcedCanonical = forced ? resolveCandidate(forced) : undefined;
  if (forcedCanonical) {
    return {
      sessionKey:
        resolveMainScopedEventSessionKey({
          cfg,
          sessionKey: forcedCanonical,
          agentId: resolvedAgentId,
        }) ?? forcedCanonical,
      storePath,
      suppressOriginatingContext: false,
    };
  }

  const trimmed = heartbeat?.session?.trim() ?? "";
  if (!trimmed || isSubagentSessionKey(trimmed)) {
    return mainSession();
  }

  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (normalized === "main" || normalized === "global") {
    return mainSession();
  }

  const canonical = resolveCandidate(trimmed);
  return canonical
    ? { sessionKey: canonical, storePath, suppressOriginatingContext: false }
    : mainSession();
}

export function resolveHeartbeatSession(
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
