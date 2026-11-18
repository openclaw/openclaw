import path from "node:path";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import type { SessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { SessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import { captureSessionStoreTargetInventory } from "../config/sessions/session-store-target-routing.js";
import { prepareSessionStoreCandidatesInWorker } from "../config/sessions/session-transcript-worker-resources.js";
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
  pathsCurrent?: () => Promise<void>;
  pathsNeedValidation?: boolean;
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
          if (!memo.current) {
            return;
          }
          if (
            filename === undefined ||
            (process.platform === "win32"
              ? filename.toLowerCase() === name.toLowerCase()
              : filename === name)
          ) {
            // Notifications can arrive in bursts across turns. Validate once on the
            // next read, not synchronously for every ancestor/recovery notification.
            memo.pathsNeedValidation = true;
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
  const currentSource = { ...params.currentSource };
  const routing = captureSessionStoreRouting(params.cfg);
  const env = captureSessionTranscriptStorageEnvironment(params.env);
  const registryOptions = { env, path: path.resolve(params.registryPath) };
  const registry = readOpenClawAgentDatabaseRegistryToken(registryOptions);
  const key = JSON.stringify([routing, env, currentSource, registryOptions.path]);
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
  // The same pending owner covers both path validation and a replacement preparation.
  if (!memo.refreshing && (memo.pathsNeedValidation || memo.dirty || memo.registry !== registry)) {
    const selected = memo;
    const previous = selected.prepared;
    const used = new Set<string>();
    selected.refreshing = true;
    selected.pathsNeedValidation = false;
    selected.prepared = (async () => {
      if (!selected.dirty && selected.registry === registry) {
        try {
          await selected.pathsCurrent?.();
          if (
            !selected.pathsNeedValidation &&
            selected.registry === readOpenClawAgentDatabaseRegistryToken(registryOptions)
          ) {
            return await previous;
          }
        } catch {
          // Changed physical paths require a new preparation under the same pending owner.
        }
      }
      if (!selected.current) {
        throw storeChanged();
      }
      selected.dirty = false;
      selected.registry = registry;
      const request = await prepareSourceRequest(
        { ...params, currentSource, registryPath: registryOptions.path },
        routing,
        env,
        selected,
        (pathname) => observeSourcePath(selected, pathname, used),
      );
      // Reuse common watches before dropping paths absent from the refreshed roster.
      for (const [observationKey, observation] of selected.observations) {
        if (!used.has(observationKey)) {
          observation.close();
          selected.observations.delete(observationKey);
        }
      }
      return request;
    })()
      .catch((error: unknown) => {
        retireSourcePreparation(key, selected);
        throw error;
      })
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
  const { currentSource } = params;
  const prepared = await prepareSessionStoreCandidatesInWorker({
    observePaths: {
      inventory: captureSessionStoreTargetInventory(
        sessionStoreRoutingConfig(routing),
        routing.agentIds,
        env,
      ),
      requiredPaths: [currentSource.path],
    },
  });
  if (!memo.current) {
    throw storeChanged();
  }
  if (!("observations" in prepared) || !prepared.observations) {
    throw new Error("Session discovery worker did not return its path observations");
  }
  let observations = prepared.observations;
  memo.pathsCurrent = async () => {
    await prepareSessionStoreCandidatesInWorker({ observePaths: { observations } });
  };
  const candidates = new Map<string, SessionStoreReadCandidate>();
  const capture = (candidate: SessionStoreReadCandidate) => {
    observe(candidate.path);
    observe(candidate.physicalPath);
    candidates.set(JSON.stringify(candidate), candidate);
  };
  observe(currentSource.path);
  prepared.candidates.forEach(capture);
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
  const registeredPaths = (registeredDatabases ?? [])
    .filter((registered) => registered.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION)
    .map((registered) => registered.path);
  if (registeredPaths.length > 0) {
    const registered = await prepareSessionStoreCandidatesInWorker({
      observePaths: { paths: registeredPaths, observations },
    });
    if (!memo.current) {
      throw storeChanged();
    }
    if (!("observations" in registered) || !registered.observations) {
      throw new Error("Session discovery worker did not return its path observations");
    }
    observations = registered.observations;
    registered.candidates.forEach(capture);
  }
  // Validate physical identities; later notifications only dirty the next read.
  memo.pathsNeedValidation = false;
  await memo.pathsCurrent();
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
