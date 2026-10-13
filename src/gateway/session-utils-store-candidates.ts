import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { SessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import { isPerAgentSessionStoreConfig } from "../config/sessions/session-store-config.js";
import type { SessionStoreTarget } from "../config/sessions/targets-collision.js";
import { isConfiguredSessionStoreAgentId } from "../config/sessions/targets-configured-agents.js";
import {
  resolveExistingAgentSessionStoreTargetsSync,
  type ExistingAgentSessionStoreTargetResolver,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

type GatewaySessionStoreDiscovery = {
  existing: SessionStoreTarget[];
  fallback: SessionStoreTarget;
};

export function resolveGatewaySessionStoreCandidates(
  cfg: OpenClawConfig,
  agentId: string,
  cache?: GatewaySessionStoreDiscoveryCache,
  excludeConfiguredFallback = false,
  env: NodeJS.ProcessEnv = process.env,
  registeredDatabases?: readonly { agentId: string; path: string }[],
  resolveExistingTargets?: ExistingAgentSessionStoreTargetResolver,
): GatewaySessionStoreDiscovery {
  const cached = cache?.get(agentId);
  if (cached) {
    return cached;
  }
  const storeConfig = cfg.session?.store;
  const fallback = {
    agentId,
    storePath: resolveSessionStorePathCore(storeConfig, { agentId, env }),
  };
  // Cached discovery also serves existing-only deleted-main lookups.
  const excludeStorePath =
    !cache && excludeConfiguredFallback && !isPerAgentSessionStoreConfig(storeConfig)
      ? fallback.storePath
      : undefined;
  const discovery = {
    existing: resolveExistingTargets
      ? resolveExistingTargets(agentId, excludeStorePath)
      : resolveExistingAgentSessionStoreTargetsSync(cfg, agentId, {
          env,
          registeredDatabases,
          excludeStorePath,
        }),
    fallback,
  };
  cache?.set(agentId, discovery);
  return discovery;
}

/**
 * Sharing resolves every returned row, but store targets are stable within one request.
 * Keep discovery agent-scoped here or each row repeats registry probes and agent-root scans.
 */
export type GatewaySessionStoreDiscoveryCache = Map<string, GatewaySessionStoreDiscovery>;

export function resolveGatewaySessionStoreLookupCandidates(params: {
  cfg: OpenClawConfig;
  agentId: string;
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
  env?: NodeJS.ProcessEnv;
  registeredDatabases?: readonly { agentId: string; path: string }[];
  resolveExistingTargets?: ExistingAgentSessionStoreTargetResolver;
}): {
  configured: boolean;
  fallback: SessionStoreTarget;
  candidates: SessionStoreTarget[];
  readSources?: SessionEntryReadSource[];
} {
  const configured = isConfiguredSessionStoreAgentId(params.cfg, params.agentId);
  if (!configured && params.registeredDatabases) {
    // Prepared discovery already holds registered owners; don't rescan retired roots per page.
    const readSources = params.registeredDatabases
      .filter((source) => normalizeAgentId(source.agentId) === params.agentId)
      .map((source) => ({ agentId: source.agentId, path: source.path }));
    return {
      configured,
      fallback: {
        agentId: params.agentId,
        storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
          agentId: params.agentId,
          env: params.env,
        }),
      },
      candidates: readSources.map((source) => ({
        agentId: source.agentId,
        storePath: source.path,
      })),
      readSources,
    };
  }
  const { existing, fallback } = resolveGatewaySessionStoreCandidates(
    params.cfg,
    params.agentId,
    params.targetDiscoveryCache,
    configured,
    params.env,
    params.registeredDatabases,
    params.resolveExistingTargets,
  );
  return {
    configured,
    fallback,
    candidates: configured
      ? [fallback, ...existing.filter((target) => target.storePath !== fallback.storePath)]
      : existing,
  };
}
