import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { SessionEntryReadSource } from "../config/sessions/session-accessor.types.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  createExistingAgentSessionStoreTargetResolver,
  listConfiguredSessionStoreAgentIds,
  resolveSessionStoreCompatibilityAgentId,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
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
  /** Only synchronous consumers may defer binding filesystem addresses. */
  deferSources?: boolean;
}): { sources: GatewaySessionStoreReadSources; assertCurrent: () => void } {
  const registryOptions = {
    env: cloneEnvWithPlatformSemantics(params.env),
    path: params.registryPath,
    includeIncompatibleSchemaVersions: true,
  };
  const currentSource = params.currentSource;
  const currentSourceAgentId = currentSource.agentId;
  const currentSourcePath = currentSource.path;
  let discoveryIsCurrent: (() => boolean) | undefined;
  let registryToken = readOpenClawAgentDatabaseRegistryToken(registryOptions);
  const assertCurrent = () => {
    const currentToken = readOpenClawAgentDatabaseRegistryToken(registryOptions);
    if (currentToken === registryToken) {
      return;
    }
    // Registration admission and metadata refreshes also rotate the memo. Keep
    // the prepared addresses only when their original discovery facts still hold.
    try {
      if (discoveryIsCurrent?.()) {
        registryToken = currentToken;
        return;
      }
    } catch {
      // An unavailable registry or locator cannot establish the captured topology.
    }
    throw new Error("Session store changed while preparing its metadata. Retry the request.");
  };
  const bindSources = () =>
    withAgentRosterFactsBatch(params.cfg, () => {
      let registered: ReturnType<typeof listOpenClawRegisteredAgentDatabases>;
      try {
        registered = listOpenClawRegisteredAgentDatabases(registryOptions);
      } catch {
        return {};
      }
      const registryFacts = registered;
      registered = registered.filter(
        (entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      const agentIds = new Set([
        ...listConfiguredSessionStoreAgentIds(params.cfg),
        ...registered.map((entry) => entry.agentId),
      ]);
      const isSameDatabasePath = createOpenClawAgentDatabasePathMatcher();
      const resolveExistingTargets = createExistingAgentSessionStoreTargetResolver(params.cfg, {
        env: params.env,
        registeredDatabases: registered,
        isSameDatabasePath,
      });
      const sources = new Map<string, readonly SessionEntryReadSource[]>();
      const bindCurrentSource = (source: SessionEntryReadSource): SessionEntryReadSource => {
        isSameDatabasePath(source.path, source.path);
        return source.agentId === currentSourceAgentId &&
          isSameDatabasePath(source.path, currentSourcePath)
          ? currentSource
          : source;
      };
      for (const agentId of agentIds) {
        try {
          const { candidates, readSources } = resolveGatewaySessionStoreLookupCandidates({
            ...params,
            agentId,
            registeredDatabases: registered,
            resolveExistingTargets,
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
              !resolved.some((resolvedSource) =>
                isSameDatabasePath(resolvedSource.path, source.path),
              )
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
      discoveryIsCurrent = () => {
        const current = listOpenClawRegisteredAgentDatabases(registryOptions);
        return (
          currentSource.agentId === currentSourceAgentId &&
          currentSource.path === currentSourcePath &&
          current.length === registryFacts.length &&
          current.every((entry, index) => {
            const previous = registryFacts[index]!;
            return (
              entry.agentId === previous.agentId &&
              entry.path === previous.path &&
              entry.schemaVersion === previous.schemaVersion
            );
          }) &&
          isSameDatabasePath.isCurrent()
        );
      };
      return Object.fromEntries(sources);
    });
  let sources = params.deferSources ? undefined : bindSources();
  return {
    get sources() {
      if (!sources) {
        assertCurrent();
        sources = bindSources();
      }
      return sources;
    },
    assertCurrent,
  };
}
