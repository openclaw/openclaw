import { isAgentDeletionBlocked } from "../agents/agent-lifecycle-registry.js";
import { resolveAgentEntry, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveSystemMainSessionTarget,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import { resolveMainScopedEventSessionKey } from "../infra/event-session-routing.js";
import {
  normalizeAgentId,
  resolveEventSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { assertAgentDatabaseAdmitted } from "../state/agent-database-admission.js";

/** Resolve scheduler work against the current agent roster and canonical session owner. */
export function createGatewayCronTargetResolver(env: NodeJS.ProcessEnv) {
  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = getRuntimeConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const defaultAgentId = tryResolveAmbientOwnerAgentId(runtimeConfig);
    if (
      normalized !== undefined &&
      normalized !== defaultAgentId &&
      !resolveAgentEntry(runtimeConfig, normalized)
    ) {
      throw new Error(`cron job agent is unavailable: ${normalized}`);
    }
    const agentId = resolveCronJobEffectiveAgentId(
      normalized ? { agentId: normalized } : {},
      defaultAgentId,
    );
    if (isAgentDeletionBlocked(agentId)) {
      throw new Error(`cron job agent is unavailable: ${agentId}`);
    }
    assertAgentDatabaseAdmitted(agentId, { env });
    return { agentId, cfg: runtimeConfig };
  };

  const resolveCronSessionKey = (paramsValue: {
    runtimeConfig: OpenClawConfig;
    agentId: string;
    requestedSessionKey?: string | null;
  }) => {
    const requested = paramsValue.requestedSessionKey?.trim();
    const candidate = toAgentStoreSessionKey({
      agentId: paramsValue.agentId,
      requestKey: requested,
      mainKey: paramsValue.runtimeConfig.session?.mainKey,
    });
    const canonical = canonicalizeMainSessionAlias({
      cfg: paramsValue.runtimeConfig,
      agentId: paramsValue.agentId,
      sessionKey: candidate,
    });
    if (canonical !== "global") {
      const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
      if (normalizeAgentId(sessionAgentId) !== normalizeAgentId(paramsValue.agentId)) {
        return resolveAgentMainSessionKey({
          cfg: paramsValue.runtimeConfig,
          agentId: paramsValue.agentId,
        });
      }
    }
    return (
      resolveMainScopedEventSessionKey({
        cfg: paramsValue.runtimeConfig,
        sessionKey: canonical,
        agentId: paramsValue.agentId,
      }) ?? canonical
    );
  };

  const resolveCronTarget = (opts?: {
    agentId?: string | null;
    sessionKey?: string | null;
    preserveUntargeted?: boolean;
  }) => {
    const requestedAgentId =
      typeof opts?.agentId === "string" && opts.agentId.trim()
        ? normalizeAgentId(opts.agentId)
        : undefined;
    const requestedSessionKey =
      typeof opts?.sessionKey === "string" && opts.sessionKey.trim() ? opts.sessionKey : undefined;
    if (opts?.preserveUntargeted && !requestedAgentId && !requestedSessionKey) {
      return { runtimeConfig: getRuntimeConfig(), agentId: undefined, sessionKey: undefined };
    }
    if (!requestedAgentId && !requestedSessionKey) {
      const runtimeConfig = getRuntimeConfig();
      return { runtimeConfig, ...resolveSystemMainSessionTarget(runtimeConfig) };
    }

    // Derive from canonical agent-prefixed keys only. Relative keys intentionally
    // fall through to the configured default instead of hardcoding "main".
    const derivedAgentId =
      requestedSessionKey && parseAgentSessionKey(requestedSessionKey)
        ? resolveAgentIdFromSessionKey(requestedSessionKey)
        : undefined;
    const { agentId, cfg: runtimeConfig } = resolveCronAgent(requestedAgentId ?? derivedAgentId);
    const resolvedSessionKey = resolveCronSessionKey({
      runtimeConfig,
      agentId,
      requestedSessionKey,
    });
    const sessionKey =
      resolvedSessionKey && runtimeConfig.session?.scope === "global"
        ? resolveEventSessionKey(
            resolvedSessionKey,
            runtimeConfig.session?.mainKey,
            runtimeConfig.session?.scope,
          )
        : resolvedSessionKey;
    return { runtimeConfig, agentId, sessionKey };
  };

  return { resolveCronAgent, resolveCronTarget };
}
