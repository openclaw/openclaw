import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { SessionEntryReadSource } from "../config/sessions/session-accessor.types.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
} from "../config/sessions/session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { shouldSkipDiscoveryError } from "../config/sessions/targets-path-validation.js";
import {
  createExistingAgentSessionStoreTargetResolver,
  listConfiguredSessionStoreAgentIds,
  resolveSessionStoreCompatibilityAgentId,
} from "../config/sessions/targets.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawRegisteredAgentDatabase,
} from "../state/openclaw-agent-db-contract.js";
import {
  AgentDatabaseRegistryChangedError,
  listOpenClawRegisteredAgentDatabases,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
  readOpenClawAgentDatabaseRegistryToken,
} from "../state/openclaw-agent-db-registry-listing.js";
import { createOpenClawAgentDatabasePathMatcher } from "../state/openclaw-agent-db.paths.js";
import { resolveGatewaySessionStoreLookupCandidates } from "./session-utils-store-lookup.js";
import type { GatewaySessionStoreReadSources } from "./session-utils-store.types.js";

type SessionStoreRouting = {
  agentIds: string[];
  store?: string;
  compatibilityAgentId: string;
};

type SourceRegistration = Pick<
  OpenClawRegisteredAgentDatabase,
  "agentId" | "path" | "schemaVersion"
>;

export type GatewaySessionStoreSourceRequest = {
  routing: SessionStoreRouting;
  currentSource: SessionEntryReadSource;
  env: NodeJS.ProcessEnv;
  registeredDatabases: readonly SourceRegistration[];
  candidates?: readonly SessionStoreReadCandidate[];
};

function captureSessionStoreRouting(cfg: OpenClawConfig): SessionStoreRouting {
  return withAgentRosterFactsBatch(cfg, () => ({
    agentIds: listConfiguredSessionStoreAgentIds(cfg),
    store: cfg.session?.store,
    compatibilityAgentId: resolveSessionStoreCompatibilityAgentId(cfg),
  }));
}

function sessionStoreRoutingConfig(routing: SessionStoreRouting): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(routing.agentIds.map((agentId) => [agentId, {}])),
      defaults: { sessionStore: { agentId: routing.compatibilityAgentId } },
    },
    session: { store: routing.store },
  };
}

function sameRegistrations(
  left: readonly SourceRegistration[],
  right: readonly SourceRegistration[],
) {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const previous = right[index]!;
      return (
        entry.agentId === previous.agentId &&
        entry.path === previous.path &&
        entry.schemaVersion === previous.schemaVersion
      );
    })
  );
}

function storeChanged(): Error {
  return new Error("Session store changed while preparing its metadata. Retry the request.");
}

/** Native discovery policy shared by synchronous readers and the admitted history worker. */
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
      isCurrent: () => isSameDatabasePath.isCurrent(),
    };
  });
}

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
      const resolved = resolveGatewaySessionStoreReadSources({
        routing: captureSessionStoreRouting(params.cfg),
        currentSource,
        env: params.env,
        registeredDatabases: registered,
      });
      discoveryIsCurrent = () => {
        const current = listOpenClawRegisteredAgentDatabases(registryOptions);
        return (
          currentSource.agentId === currentSourceAgentId &&
          currentSource.path === currentSourcePath &&
          sameRegistrations(current, registryFacts) &&
          resolved.isCurrent()
        );
      };
      return resolved.sources;
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

/** Capture source routing for the existing history worker; no native discovery runs here. */
export async function prepareGatewaySessionStoreReadSourcesAsync(params: {
  cfg: OpenClawConfig;
  currentSource: SessionEntryReadSource;
  env: NodeJS.ProcessEnv;
  registryPath: string;
}) {
  const routing = captureSessionStoreRouting(params.cfg);
  const env = captureSessionTranscriptStorageEnvironment(params.env);
  const inventory = prepareSessionStoreTargetInventory(
    sessionStoreRoutingConfig(routing),
    routing.agentIds,
    env,
  );
  const currentSource = { ...params.currentSource };
  const paths = createOpenClawAgentDatabasePathMatcher();
  paths(currentSource.path, currentSource.path);
  const candidates = new Map<string, SessionStoreReadCandidate>();
  const unavailablePaths = new Set<string>();
  const capture = (candidate: SessionStoreReadCandidate) => {
    if (unavailablePaths.has(candidate.path)) {
      return;
    }
    try {
      paths(candidate.path, candidate.path);
    } catch (error) {
      if (!shouldSkipDiscoveryError(error)) {
        throw error;
      }
      // A failed auxiliary locator cannot gain fresh custody after registry preparation yields.
      unavailablePaths.add(candidate.path);
      return;
    }
    candidates.set(JSON.stringify(candidate), candidate);
  };
  inventory.candidates.forEach(capture);
  capture(captureSessionStoreReadCandidate(currentSource.path));
  const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({
    env,
    path: params.registryPath,
    includeIncompatibleSchemaVersions: true,
  });
  let registry = await registryRead.read();
  const original = registry.result;
  const assertSourceCurrent = () => {
    if (
      params.currentSource.agentId !== currentSource.agentId ||
      params.currentSource.path !== currentSource.path ||
      !paths.isCurrent()
    ) {
      throw storeChanged();
    }
  };
  const assertCurrent = () => {
    assertSourceCurrent();
    try {
      registry.assertCurrent();
    } catch (error) {
      if (error instanceof AgentDatabaseRegistryChangedError) {
        throw storeChanged();
      }
      throw error;
    }
  };
  assertCurrent();
  const registeredDatabases =
    original.status === "available"
      ? original.entries.map(({ agentId, path, schemaVersion }) => ({
          agentId,
          path,
          schemaVersion,
        }))
      : undefined;
  for (const registered of registeredDatabases ?? []) {
    if (registered.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION) {
      capture(captureSessionStoreReadCandidate(registered.path));
    }
  }
  const request: GatewaySessionStoreSourceRequest | undefined = registeredDatabases
    ? {
        routing,
        currentSource,
        env,
        registeredDatabases,
        candidates: [...candidates.values()],
      }
    : undefined;
  return {
    request,
    assertSourceCurrent,
    assertCurrent,
    async revalidate(assertCallerCurrent: () => void) {
      assertCallerCurrent();
      assertSourceCurrent();
      try {
        registry.assertCurrent();
        return;
      } catch (error) {
        if (!(error instanceof AgentDatabaseRegistryChangedError)) {
          throw error;
        }
      }
      const current = await registryRead.read();
      assertCallerCurrent();
      assertSourceCurrent();
      current.assertCurrent();
      if (
        current.result.status !== original.status ||
        (current.result.status === "available" &&
          original.status === "available" &&
          !sameRegistrations(current.result.entries, original.entries))
      ) {
        throw storeChanged();
      }
      registry = current;
    },
  };
}
