import type { SessionEntryReadSource } from "../config/sessions/session-accessor.types.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveSessionStoreCompatibilityAgentId,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listOpenClawRegisteredAgentDatabases,
  readOpenClawAgentDatabaseRegistryToken,
} from "../state/openclaw-agent-db-registry-listing.js";
import { createOpenClawAgentDatabasePathMatcher } from "../state/openclaw-agent-db-registry.js";
import { resolveGatewaySessionStoreLookupCandidates } from "./session-utils-store-lookup.js";
import type { GatewaySessionStoreReadSources } from "./session-utils-store.types.js";

/** Bind candidate addresses once; registry metadata uses its existing invalidation owner. */
export function prepareGatewaySessionStoreReadSources(params: {
  cfg: OpenClawConfig;
  currentSource: SessionEntryReadSource;
  env: NodeJS.ProcessEnv;
  registryPath: string;
}): { sources: GatewaySessionStoreReadSources; assertCurrent: () => void } {
  const registryOptions = { env: params.env, path: params.registryPath };
  const registryToken = readOpenClawAgentDatabaseRegistryToken(registryOptions);
  const assertCurrent = () => {
    if (readOpenClawAgentDatabaseRegistryToken(registryOptions) !== registryToken) {
      throw new Error("Session store changed while preparing its metadata. Retry the request.");
    }
  };
  let registered: ReturnType<typeof listOpenClawRegisteredAgentDatabases>;
  try {
    registered = listOpenClawRegisteredAgentDatabases(registryOptions);
  } catch {
    return { sources: {}, assertCurrent };
  }
  const agentIds = new Set([
    ...listConfiguredSessionStoreAgentIds(params.cfg),
    ...registered.map((entry) => entry.agentId),
  ]);
  const sources = new Map<string, readonly SessionEntryReadSource[]>();
  const isSameDatabasePath = createOpenClawAgentDatabasePathMatcher();
  const bindCurrentSource = (source: SessionEntryReadSource): SessionEntryReadSource =>
    source.agentId === params.currentSource.agentId &&
    isSameDatabasePath(source.path, params.currentSource.path)
      ? params.currentSource
      : source;
  for (const agentId of agentIds) {
    try {
      const { candidates, readSources } = resolveGatewaySessionStoreLookupCandidates({
        ...params,
        agentId,
        registeredDatabases: registered,
      });
      const resolved: SessionEntryReadSource[] = [];
      if (readSources) {
        for (const readSource of readSources) {
          const source = bindCurrentSource(readSource);
          if (
            !resolved.some(
              (candidate) =>
                candidate.agentId === source.agentId &&
                isSameDatabasePath(candidate.path, source.path),
            )
          ) {
            resolved.push(source);
          }
        }
        sources.set(agentId, resolved);
        continue;
      }
      for (const candidate of candidates) {
        const target = resolveSqliteTargetFromSessionStorePath(candidate.storePath, {
          agentId: candidate.agentId,
          defaultAgentId: resolveSessionStoreCompatibilityAgentId(params.cfg),
          env: params.env,
          registeredDatabases: registered,
          isSameDatabasePath,
        });
        if (target.ownerSource === "ambiguous-registry") {
          resolved.length = 0;
          break;
        }
        const source = bindCurrentSource({
          agentId: target.agentId ?? candidate.agentId,
          path: target.path,
        });
        if (
          !resolved.some((resolvedSource) => isSameDatabasePath(resolvedSource.path, source.path))
        ) {
          resolved.push(source);
        }
      }
      sources.set(agentId, resolved);
    } catch {
      // Auxiliary lineage follows the existing unavailable-store-as-no-rows contract.
      sources.set(agentId, []);
    }
  }
  return {
    sources: Object.fromEntries(sources),
    assertCurrent,
  };
}
