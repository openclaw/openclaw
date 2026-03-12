import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles.js";
import {
  clearRuntimeSubagentRunsSnapshot,
  replaceRuntimeSubagentRunsSnapshot,
} from "../agents/subagent-registry-state.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  loadAuthProfileStoreSnapshotsFromPostgres,
  loadSubagentRunsFromPostgres,
} from "./service.js";
import { discoverPersistenceArtifacts } from "./storage.js";

const authBootstrapTasks = new Map<string, Promise<void>>();
let primedAuthBootstrapKey: string | null = null;
const bootstrappedAuthKeys = new Set<string>();
const bootstrappedSubagentKeys = new Set<string>();

function buildAuthBootstrapKey(config: OpenClawConfig): string {
  return JSON.stringify({
    backend: config.persistence?.backend ?? null,
    postgres: config.persistence?.postgres
      ? {
          url: config.persistence.postgres.url ?? null,
          schema: config.persistence.postgres.schema ?? null,
          maxConnections: config.persistence.postgres.maxConnections ?? null,
          encryptionKey: config.persistence.postgres.encryptionKey ?? null,
          exportCompatibility: config.persistence.postgres.exportCompatibility ?? null,
        }
      : null,
  });
}

export async function bootstrapPostgresRuntimeState(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  auth?: boolean;
  subagents?: boolean;
}): Promise<{ authStores: number; subagentRuns: number }> {
  if (params.config.persistence?.backend !== "postgres") {
    return { authStores: 0, subagentRuns: 0 };
  }

  let authStores = 0;
  let subagentRuns = 0;
  let nextAuthStores:
    | Awaited<ReturnType<typeof loadAuthProfileStoreSnapshotsFromPostgres>>
    | undefined;
  let nextSubagentRuns: Awaited<ReturnType<typeof loadSubagentRunsFromPostgres>> | undefined;

  if (params.auth !== false) {
    nextAuthStores = await loadAuthProfileStoreSnapshotsFromPostgres({
      config: params.config,
      env: params.env,
      lookupMode: "runtime",
    });
    authStores = nextAuthStores.length;
  }

  if (params.subagents !== false) {
    nextSubagentRuns = await loadSubagentRunsFromPostgres({
      config: params.config,
      env: params.env,
      lookupMode: "runtime",
    });
    subagentRuns = nextSubagentRuns.size;
  }

  const artifacts = await discoverPersistenceArtifacts(params.config, params.env);
  const validationErrors: string[] = [];
  if (params.auth !== false && artifacts.authStores.length > 0 && authStores === 0) {
    validationErrors.push(
      "Auth profile files exist on disk but Postgres has no auth stores. Run `openclaw storage migrate --to postgres` before enabling Postgres persistence.",
    );
  }
  if (params.subagents !== false && artifacts.subagentRegistryPath && subagentRuns === 0) {
    validationErrors.push(
      "A subagent registry file exists on disk but Postgres has no subagent runs. Run `openclaw storage migrate --to postgres` before enabling Postgres persistence.",
    );
  }
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("\n"));
  }

  const bootstrapKey = buildAuthBootstrapKey(params.config);
  if (params.auth !== false) {
    bootstrappedAuthKeys.add(bootstrapKey);
    if (nextAuthStores && nextAuthStores.length > 0) {
      replaceRuntimeAuthProfileStoreSnapshots(nextAuthStores);
    } else {
      clearRuntimeAuthProfileStoreSnapshots();
    }
  }
  if (params.subagents !== false) {
    bootstrappedSubagentKeys.add(bootstrapKey);
    if (nextSubagentRuns && nextSubagentRuns.size > 0) {
      replaceRuntimeSubagentRunsSnapshot(nextSubagentRuns);
    } else {
      clearRuntimeSubagentRunsSnapshot();
    }
  }

  return {
    authStores,
    subagentRuns,
  };
}

export function hasBootstrappedPostgresAuthRuntimeState(config: OpenClawConfig): boolean {
  return bootstrappedAuthKeys.has(buildAuthBootstrapKey(config));
}

export function hasBootstrappedPostgresSubagentRuntimeState(config: OpenClawConfig): boolean {
  return bootstrappedSubagentKeys.has(buildAuthBootstrapKey(config));
}

export async function primePostgresAuthRuntimeState(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (params.config.persistence?.backend !== "postgres") {
    return;
  }

  const key = buildAuthBootstrapKey(params.config);
  if (primedAuthBootstrapKey === key) {
    return;
  }
  const existing = authBootstrapTasks.get(key);
  if (existing) {
    await existing;
    return;
  }

  // Several async command helpers can converge on the same auth priming step.
  // Coalesce only in-flight work; later calls still refresh from Postgres.
  const task = bootstrapPostgresRuntimeState({
    config: params.config,
    env: params.env,
    auth: true,
    subagents: false,
  }).then((result) => {
    // Cache only populated snapshots so long-lived processes can still observe
    // auth stores that appear later after starting from an empty database.
    if (result.authStores > 0) {
      primedAuthBootstrapKey = key;
    }
  });
  authBootstrapTasks.set(key, task);
  try {
    await task;
  } finally {
    if (authBootstrapTasks.get(key) === task) {
      authBootstrapTasks.delete(key);
    }
  }
}

export function clearPostgresRuntimeState(options?: { auth?: boolean; subagents?: boolean }): void {
  if (options?.auth !== false) {
    clearRuntimeAuthProfileStoreSnapshots();
    authBootstrapTasks.clear();
    primedAuthBootstrapKey = null;
    bootstrappedAuthKeys.clear();
  }
  if (options?.subagents !== false) {
    clearRuntimeSubagentRunsSnapshot();
    bootstrappedSubagentKeys.clear();
  }
}
