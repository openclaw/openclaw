import path from "node:path";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import type { SessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import {
  captureSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
} from "../config/sessions/session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { shouldSkipDiscoveryError } from "../config/sessions/targets-path-validation.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveSessionStoreCompatibilityAgentId,
} from "../config/sessions/targets.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { observeOwnedDirectory } from "../infra/owned-directory-observation.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
  readOpenClawAgentDatabaseRegistryToken,
} from "../state/openclaw-agent-db-registry-listing.js";
import { createOpenClawAgentDatabasePathMatcher } from "../state/openclaw-agent-db.paths.js";
import {
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseAsyncResource,
} from "../state/openclaw-state-db-cache.js";
import { sessionStoreRoutingConfig } from "./session-utils-store-candidates.js";
import type { GatewaySessionStoreSourceRequest } from "./session-utils-store.types.js";

type SessionStoreRouting = GatewaySessionStoreSourceRequest["routing"];

function captureSessionStoreRouting(cfg: OpenClawConfig): SessionStoreRouting {
  return withAgentRosterFactsBatch(cfg, () => ({
    agentIds: listConfiguredSessionStoreAgentIds(cfg),
    store: cfg.session?.store,
    compatibilityAgentId: resolveSessionStoreCompatibilityAgentId(cfg),
  }));
}

function storeChanged(): Error {
  return new Error("Session store changed while preparing its metadata. Retry the request.");
}

type SourcePreparationParams = {
  cfg: OpenClawConfig;
  currentSource: SessionEntryReadSource;
  env: NodeJS.ProcessEnv;
  registryPath: string;
};

type SourceMemo = {
  registry: symbol;
  registryIdentity: string | undefined;
  current: boolean;
  observations: Map<string, { close(): void }>;
  dirty?: boolean;
  refreshing?: boolean;
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
  if (sourcePreparations.get(key) === memo) {
    sourcePreparations.delete(key);
  }
}

function observeSourcePath(memo: SourceMemo, pathname: string, used: Set<string>): void {
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
    used.add(observationKey);
    if (!memo.observations.has(observationKey)) {
      memo.observations.set(
        observationKey,
        observeOwnedDirectory(directory, (filename, event) => {
          // Content writes do not replace the prepared source identities.
          if (event === "change" && filename !== undefined) {
            return;
          }
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
            // The next read refreshes facts without retiring shared watches.
            try {
              if (memo.pathsCurrent && !memo.pathsCurrent()) {
                memo.dirty = true;
              }
            } catch {
              memo.dirty = true;
            }
          }
        }),
      );
    }
    child = directory;
  }
}

/** Retain discovery facts and watches; ordinary reads refresh invalidated facts in place. */
export async function prepareGatewaySessionStoreReadSourcesAsync(
  params: SourcePreparationParams,
): Promise<{ request: GatewaySessionStoreSourceRequest | undefined }> {
  const routing = captureSessionStoreRouting(params.cfg);
  const env = captureSessionTranscriptStorageEnvironment(params.env);
  const registryOptions = { env, path: path.resolve(params.registryPath) };
  const registry = readOpenClawAgentDatabaseRegistryToken(registryOptions);
  const key = JSON.stringify([routing, env, params.currentSource, registryOptions.path]);
  let memo = sourcePreparations.get(key);
  if (!memo) {
    memo = {
      registry,
      registryIdentity: openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(
        registryOptions.path,
      )?.key,
      current: true,
      observations: new Map(),
      dirty: true,
      prepared: Promise.resolve(undefined),
    };
    sourcePreparations.set(key, memo);
  }
  // One refresh owns the used-watch set; publications during it share its outcome.
  if (!memo.refreshing && (memo.dirty || memo.registry !== registry)) {
    const selected = memo;
    const used = new Set<string>();
    selected.refreshing = true;
    selected.dirty = false;
    selected.registry = registry;
    selected.prepared = prepareSourceRequest(
      { ...params, registryPath: registryOptions.path },
      routing,
      env,
      selected,
      (pathname) => observeSourcePath(selected, pathname, used),
    )
      .then(
        (request) => {
          // Reuse common watches before dropping paths absent from the refreshed roster.
          for (const [observationKey, observation] of selected.observations) {
            if (!used.has(observationKey)) {
              observation.close();
              selected.observations.delete(observationKey);
            }
          }
          return request;
        },
        (error: unknown) => {
          retireSourcePreparation(key, selected);
          throw error;
        },
      )
      .finally(() => {
        selected.refreshing = false;
      });
    while (sourcePreparations.size > 128) {
      const [oldestKey, oldest] = sourcePreparations.entries().next().value!;
      retireSourcePreparation(oldestKey, oldest);
    }
  }
  const request = await memo.prepared;
  if (!memo.current) {
    throw storeChanged();
  }
  return { request };
}

async function prepareSourceRequest(
  params: SourcePreparationParams,
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
  const { currentSource } = params;
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
