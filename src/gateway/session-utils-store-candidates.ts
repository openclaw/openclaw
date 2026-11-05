import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { SessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { isPerAgentSessionStoreConfig } from "../config/sessions/session-store-config.js";
import { assertSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import type { SessionStoreTarget } from "../config/sessions/targets-collision.js";
import {
  isConfiguredSessionStoreAgentId,
  listConfiguredSessionStoreAgentIds,
} from "../config/sessions/targets-configured-agents.js";
import { createExistingAgentSessionStoreTargetResolver } from "../config/sessions/targets-discovery.native.js";
import type { ExistingAgentSessionStoreTargetResolver } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { createOpenClawAgentDatabasePathMatcher } from "../state/openclaw-agent-db.paths.js";
import type { GatewaySessionStoreSourceRequest } from "./session-utils-store.types.js";

type GatewaySessionStoreDiscovery = {
  existing: readonly Readonly<SessionStoreTarget>[];
  fallback: SessionStoreTarget;
};

export function resolveGatewaySessionStoreCandidates(
  cfg: OpenClawConfig,
  agentId: string,
  cache?: GatewaySessionStoreDiscoveryCache,
  excludeConfiguredFallback = false,
  env: NodeJS.ProcessEnv = process.env,
  resolveExistingTargets?: ExistingAgentSessionStoreTargetResolver,
): GatewaySessionStoreDiscovery {
  const cached = cache?.get(agentId);
  if (cached) {
    return cached;
  }
  if (!resolveExistingTargets) {
    throw new Error("Session store discovery must be prepared in the read worker");
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
    existing: resolveExistingTargets(agentId, excludeStorePath),
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
  candidates: readonly Readonly<SessionStoreTarget>[];
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

export function sessionStoreRoutingConfig(
  routing: GatewaySessionStoreSourceRequest["routing"],
): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(routing.agentIds.map((agentId) => [agentId, {}])),
      defaults: { sessionStore: { agentId: routing.compatibilityAgentId } },
    },
    session: { store: routing.store },
  };
}

/** Resolve captured native discovery facts inside the admitted history worker. */
export function resolveGatewaySessionStoreReadSources(params: GatewaySessionStoreSourceRequest) {
  const cfg = sessionStoreRoutingConfig(params.routing);
  return withAgentRosterFactsBatch(cfg, () => {
    const registered = params.registeredDatabases.filter(
      (entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION,
    );
    const agentIds = new Set([
      ...listConfiguredSessionStoreAgentIds(cfg),
      ...registered.map((entry) => entry.agentId),
    ]);
    const isSameDatabasePath = createOpenClawAgentDatabasePathMatcher();
    const resolveExistingTargets = createExistingAgentSessionStoreTargetResolver(cfg, {
      env: params.env,
      registeredDatabases: registered,
      readCandidates: params.candidates,
      isSameDatabasePath,
    });
    const sources = new Map<string, readonly SessionEntryReadSource[]>();
    const bindCurrentSource = (source: SessionEntryReadSource): SessionEntryReadSource => {
      if (params.candidates) {
        assertSessionStoreReadCandidate(source.path, params.candidates);
      }
      isSameDatabasePath(source.path, source.path);
      return source.agentId === params.currentSource.agentId &&
        isSameDatabasePath(source.path, params.currentSource.path)
        ? params.currentSource
        : source;
    };
    for (const agentId of agentIds) {
      let resolved: SessionEntryReadSource[];
      let exactRegisteredSources = false;
      try {
        const { candidates, readSources } = resolveGatewaySessionStoreLookupCandidates({
          ...params,
          cfg,
          agentId,
          registeredDatabases: registered,
          resolveExistingTargets,
        });
        resolved = [];
        if (readSources) {
          exactRegisteredSources = true;
          resolved = readSources;
        } else {
          for (const candidate of candidates) {
            const target = resolveSqliteTargetFromSessionStorePath(candidate.storePath, {
              agentId: candidate.agentId,
              defaultAgentId: resolveSessionStoreCompatibilityAgentId(cfg),
              env: params.env,
              registeredDatabases: registered,
              readCandidates: params.candidates,
              isSameDatabasePath,
            });
            if (target.ownerSource === "ambiguous-registry") {
              resolved.length = 0;
              break;
            }
            resolved.push({ agentId: target.agentId ?? candidate.agentId, path: target.path });
          }
        }
        const bound: SessionEntryReadSource[] = [];
        for (const source of resolved) {
          const current = bindCurrentSource(source);
          if (
            !bound.some(
              (previous) =>
                (!exactRegisteredSources || previous.agentId === current.agentId) &&
                isSameDatabasePath(previous.path, current.path),
            )
          ) {
            bound.push(current);
          }
        }
        sources.set(agentId, bound);
      } catch {
        // Auxiliary lineage follows the existing unavailable-store-as-no-rows contract.
        sources.set(agentId, []);
        continue;
      }
    }
    return {
      sources: Object.fromEntries(sources),
    };
  });
}
