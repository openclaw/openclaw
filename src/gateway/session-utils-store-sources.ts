import path from "node:path";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { SessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
} from "../config/sessions/session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { createExistingAgentSessionStoreTargetResolver } from "../config/sessions/targets-discovery.native.js";
import { shouldSkipDiscoveryError } from "../config/sessions/targets-path-validation.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveSessionStoreCompatibilityAgentId,
} from "../config/sessions/targets.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { observeOwnedDirectory } from "../infra/owned-directory-observation.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  listOpenClawRegisteredAgentDatabases,
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
  readOpenClawAgentDatabaseRegistryToken,
} from "../state/openclaw-agent-db-registry-listing.js";
import { createOpenClawAgentDatabasePathMatcher } from "../state/openclaw-agent-db.paths.js";
import {
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseAsyncResource,
} from "../state/openclaw-state-db-cache.js";
import { resolveGatewaySessionStoreLookupCandidates } from "./session-utils-store-candidates.js";
import type {
  GatewaySessionStoreReadSources,
  GatewaySessionStoreSourceRequest,
} from "./session-utils-store.types.js";

type SessionStoreRouting = GatewaySessionStoreSourceRequest["routing"];

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
}): { sources: GatewaySessionStoreReadSources; assertCurrent: () => void } {
  const registryOptions = {
    env: cloneEnvWithPlatformSemantics(params.env),
    path: params.registryPath,
    includeIncompatibleSchemaVersions: true,
  };
  let discoveryIsCurrent = () => true;
  const sources = withAgentRosterFactsBatch(params.cfg, () => {
    let registered: ReturnType<typeof listOpenClawRegisteredAgentDatabases>;
    try {
      registered = listOpenClawRegisteredAgentDatabases(registryOptions);
    } catch {
      return {};
    }
    const resolved = resolveGatewaySessionStoreReadSources({
      routing: captureSessionStoreRouting(params.cfg),
      currentSource: params.currentSource,
      env: params.env,
      registeredDatabases: registered,
    });
    discoveryIsCurrent = resolved.isCurrent;
    return resolved.sources;
  });
  return {
    sources,
    assertCurrent() {
      if (!discoveryIsCurrent()) {
        throw storeChanged();
      }
    },
  };
}

type SourcePreparation = {
  request: GatewaySessionStoreSourceRequest | undefined;
  assertCurrent: () => void;
};
type SourceMemo = {
  registry: symbol;
  registryIdentity: string | undefined;
  current: boolean;
  observations: Map<string, { close(): void }>;
  /** Superseded generation whose watches stay until this one observes the same paths. */
  replaced?: SourceMemo;
  pathsCurrent?: () => boolean;
  observedThisTurn?: boolean;
  prepared: Promise<GatewaySessionStoreSourceRequest | undefined>;
};
const sourcePreparations = new Map<string, SourceMemo>();
registerOpenClawStateDatabaseAsyncResource({
  close: async (identity) => {
    for (const [key, memo] of sourcePreparations) {
      if (!identity || !memo.registryIdentity || memo.registryIdentity === identity.key) {
        retireSourcePreparation(key, memo);
      }
    }
  },
});

function retireSourcePreparation(key: string, memo: SourceMemo): void {
  memo.current = false;
  for (const observation of memo.observations.values()) {
    observation.close();
  }
  memo.observations.clear();
  if (memo.replaced) {
    retireSourcePreparation(key, memo.replaced);
    memo.replaced = undefined;
  }
  if (sourcePreparations.get(key) === memo) {
    sourcePreparations.delete(key);
  }
}

function observeSourcePath(memo: SourceMemo, pathname: string): void {
  if (!memo.current) {
    return;
  }
  let child = path.resolve(pathname);
  for (;;) {
    const directory = path.dirname(child);
    if (directory === child) {
      return;
    }
    const name = path.basename(child);
    const observationKey = JSON.stringify([directory, name]);
    if (!memo.observations.has(observationKey)) {
      memo.observations.set(
        observationKey,
        observeOwnedDirectory(
          directory,
          (filename) => {
            if (!memo.current || memo.observedThisTurn) {
              return;
            }
            if (
              filename === undefined ||
              (process.platform === "win32"
                ? filename.toLowerCase() === name.toLowerCase()
                : filename === name)
            ) {
              // One fallback sweep can notify every ancestor of the same source.
              memo.observedThisTurn = true;
              queueMicrotask(() => {
                memo.observedThisTurn = false;
              });
              // Invalidate only; the next preparation inherits these watches.
              try {
                if (memo.pathsCurrent && !memo.pathsCurrent()) {
                  memo.current = false;
                }
              } catch {
                memo.current = false;
              }
            }
          },
          { recoveryIntervalMs: 30_000 },
        ),
      );
    }
    child = directory;
  }
}

/** Retain discovery facts; registry receipts and directory observations revoke their generation. */
export async function prepareGatewaySessionStoreReadSourcesAsync(
  params: Parameters<typeof prepareGatewaySessionStoreReadSources>[0],
  signal?: AbortSignal,
): Promise<SourcePreparation> {
  signal?.throwIfAborted();
  const routing = captureSessionStoreRouting(params.cfg);
  const env = captureSessionTranscriptStorageEnvironment(params.env);
  const registryOptions = { env, path: path.resolve(params.registryPath) };
  const registry = readOpenClawAgentDatabaseRegistryToken(registryOptions);
  const key = JSON.stringify([routing, env, params.currentSource, registryOptions.path]);
  let memo = sourcePreparations.get(key);
  let replaced: SourceMemo | undefined;
  if (memo && (!memo.current || memo.registry !== registry)) {
    // Closing a native directory watch can block the main thread for seconds on
    // macOS. Keep shared watches until the replacement observes the same paths.
    replaced = memo;
    replaced.current = false;
    memo = undefined;
  }
  if (!memo) {
    const created: SourceMemo = {
      registry,
      registryIdentity: openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(
        registryOptions.path,
      )?.key,
      current: true,
      observations: new Map(),
      replaced,
      prepared: Promise.resolve(undefined),
    };
    memo = created;
    sourcePreparations.set(key, created);
    created.prepared = prepareSourceRequest(
      { ...params, registryPath: registryOptions.path },
      routing,
      env,
      created,
      (pathname) => observeSourcePath(created, pathname),
    ).catch((error: unknown) => {
      retireSourcePreparation(key, created);
      throw error;
    });
    if (replaced) {
      const releaseReplaced = () => {
        if (created.replaced === replaced) {
          created.replaced = undefined;
          retireSourcePreparation(key, replaced);
        }
      };
      void created.prepared.then(releaseReplaced, releaseReplaced);
    }
    while (sourcePreparations.size > 128) {
      const [oldestKey, oldest] = sourcePreparations.entries().next().value!;
      retireSourcePreparation(oldestKey, oldest);
    }
  }
  const request = await racePromiseWithAbortSignal(
    memo.prepared,
    signal,
    (aborted) => aborted.reason,
  );
  signal?.throwIfAborted();
  const captured = memo;
  const assertCurrent = () => {
    if (
      !captured.current ||
      captured.registry !== readOpenClawAgentDatabaseRegistryToken(registryOptions)
    ) {
      // The next preparation replaces this generation and inherits its watches.
      captured.current = false;
      throw storeChanged();
    }
  };
  assertCurrent();
  return { request: request && structuredClone(request), assertCurrent };
}

async function prepareSourceRequest(
  params: Parameters<typeof prepareGatewaySessionStoreReadSources>[0],
  routing: SessionStoreRouting,
  env: NodeJS.ProcessEnv,
  memo: SourceMemo,
  observe: (pathname: string) => void,
): Promise<GatewaySessionStoreSourceRequest | undefined> {
  const paths = createOpenClawAgentDatabasePathMatcher();
  memo.pathsCurrent = () => paths.isCurrent();
  paths(params.registryPath, params.registryPath);
  observe(params.registryPath);
  const inventory = prepareSessionStoreTargetInventory(
    sessionStoreRoutingConfig(routing),
    routing.agentIds,
    env,
  );
  const currentSource = { ...params.currentSource };
  paths(currentSource.path, currentSource.path);
  observe(currentSource.path);
  const candidates = new Map<string, SessionStoreReadCandidate>();
  const capture = (candidate: SessionStoreReadCandidate) => {
    try {
      paths(candidate.path, candidate.path);
    } catch (error) {
      if (!shouldSkipDiscoveryError(error)) {
        throw error;
      }
      return;
    }
    observe(candidate.path);
    observe(candidate.physicalPath);
    candidates.set(JSON.stringify(candidate), candidate);
  };
  inventory.candidates.forEach(capture);
  capture(captureSessionStoreReadCandidate(currentSource.path));
  const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({
    env,
    path: params.registryPath,
    includeIncompatibleSchemaVersions: true,
  });
  const registry = await registryRead.read();
  if (!memo.current) {
    throw storeChanged();
  }
  const original = registry.result;
  const registeredDatabases =
    original.status === "available"
      ? original.entries.map(({ agentId, path: databasePath, schemaVersion }) => ({
          agentId,
          path: databasePath,
          schemaVersion,
        }))
      : undefined;
  for (const registered of registeredDatabases ?? []) {
    if (registered.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION) {
      capture(captureSessionStoreReadCandidate(registered.path));
    }
  }
  // Observation was installed after capture; close that admission window before publication.
  if (!paths.isCurrent()) {
    throw storeChanged();
  }
  registry.assertCurrent();
  memo.registry = readOpenClawAgentDatabaseRegistryToken({ env, path: params.registryPath });
  return registeredDatabases
    ? {
        routing,
        currentSource,
        env,
        registeredDatabases,
        candidates: [...candidates.values()],
      }
    : undefined;
}
