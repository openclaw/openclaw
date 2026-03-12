import postgres from "postgres";
import * as configModule from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveConfiguredSecretInputString } from "../gateway/resolve-configured-secret-input-string.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("persistence/postgres");

export type ResolvedPostgresPersistenceConfig = {
  url: string;
  schema: string;
  maxConnections: number;
  encryptionKey?: string;
  exportCompatibility: boolean;
};

type SqlClient = ReturnType<typeof postgres>;
export type PostgresPersistenceLookupMode = "runtime" | "configured";

export type RuntimePostgresPersistencePolicy = {
  enabled: boolean;
  exportCompatibility: boolean;
};

function safeLoadConfigSync(): OpenClawConfig | null {
  const runtime = safeGetRuntimeConfigSnapshot();
  if (runtime) {
    return runtime;
  }
  try {
    return safeLoadConfig();
  } catch {
    return null;
  }
}

async function loadPersistenceConfigSource(): Promise<OpenClawConfig | null> {
  const runtime = safeGetRuntimeConfigSnapshot();
  if (runtime) {
    return runtime;
  }
  try {
    return safeLoadConfig();
  } catch {
    try {
      return await safeReadBestEffortConfig();
    } catch {
      return null;
    }
  }
}

function safeGetRuntimeConfigSnapshot(): OpenClawConfig | null {
  const getter =
    "getRuntimeConfigSnapshot" in configModule &&
    typeof configModule.getRuntimeConfigSnapshot === "function"
      ? configModule.getRuntimeConfigSnapshot
      : null;
  if (!getter) {
    return null;
  }
  try {
    return getter();
  } catch {
    return null;
  }
}

function safeLoadConfig(): OpenClawConfig | null {
  const loader =
    "loadConfig" in configModule && typeof configModule.loadConfig === "function"
      ? configModule.loadConfig
      : null;
  if (!loader) {
    return null;
  }
  return loader();
}

async function safeReadBestEffortConfig(): Promise<OpenClawConfig | null> {
  const reader =
    "readBestEffortConfig" in configModule &&
    typeof configModule.readBestEffortConfig === "function"
      ? configModule.readBestEffortConfig
      : null;
  if (!reader) {
    return null;
  }
  return await reader();
}

async function resolvePostgresPersistenceConfigFromSource(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  mode: PostgresPersistenceLookupMode;
}): Promise<ResolvedPostgresPersistenceConfig | null> {
  const env = params.env ?? process.env;
  if (params.mode === "runtime" && params.config.persistence?.backend !== "postgres") {
    return null;
  }
  if (!params.config.persistence?.postgres) {
    return null;
  }

  const urlResolution = await resolveConfiguredSecretInputString({
    config: params.config,
    env,
    value: params.config.persistence?.postgres?.url,
    path: "persistence.postgres.url",
  });
  const url = urlResolution.value?.trim();
  if (!url) {
    if (urlResolution.unresolvedRefReason) {
      log.warn(urlResolution.unresolvedRefReason);
    }
    return null;
  }

  const encryptionKeyResolution = await resolveConfiguredSecretInputString({
    config: params.config,
    env,
    value: params.config.persistence?.postgres?.encryptionKey,
    path: "persistence.postgres.encryptionKey",
  });

  return {
    url,
    schema: params.config.persistence?.postgres?.schema?.trim() || "openclaw",
    maxConnections: params.config.persistence?.postgres?.maxConnections ?? 4,
    encryptionKey: encryptionKeyResolution.value?.trim() || undefined,
    exportCompatibility: params.config.persistence?.postgres?.exportCompatibility !== false,
  };
}

export function isPostgresPersistenceEnabled(): boolean {
  return safeLoadConfigSync()?.persistence?.backend === "postgres";
}

export function getRuntimePostgresPersistencePolicySync(): RuntimePostgresPersistencePolicy {
  const cfg = safeLoadConfigSync();
  if (cfg?.persistence?.backend !== "postgres") {
    return {
      enabled: false,
      exportCompatibility: false,
    };
  }
  return {
    enabled: true,
    exportCompatibility: cfg.persistence?.postgres?.exportCompatibility !== false,
  };
}

export function quoteSqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export async function resolvePostgresPersistenceConfig(
  mode: PostgresPersistenceLookupMode = "runtime",
): Promise<ResolvedPostgresPersistenceConfig | null> {
  const cfg = await loadPersistenceConfigSource();
  if (!cfg) {
    return null;
  }
  return await resolvePostgresPersistenceConfigFromSource({
    config: cfg,
    mode,
  });
}

export async function resolvePostgresPersistenceConfigFromConfig(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  mode?: PostgresPersistenceLookupMode;
}): Promise<ResolvedPostgresPersistenceConfig | null> {
  return await resolvePostgresPersistenceConfigFromSource({
    config: params.config,
    env: params.env,
    mode: params.mode ?? "runtime",
  });
}

export class PostgresPersistenceClient {
  readonly sql: SqlClient;
  readonly config: ResolvedPostgresPersistenceConfig;
  readonly schemaSql: string;
  #readyPromise: Promise<void> | null = null;

  constructor(config: ResolvedPostgresPersistenceConfig) {
    this.config = config;
    this.schemaSql = quoteSqlIdentifier(config.schema);
    this.sql = postgres(config.url, {
      max: config.maxConnections,
      idle_timeout: 5,
      connect_timeout: 10,
    });
  }

  async ensureReady(): Promise<void> {
    if (!this.#readyPromise) {
      this.#readyPromise = this.#createSchema();
    }
    await this.#readyPromise;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 0 });
  }

  async #createSchema(): Promise<void> {
    const schema = this.schemaSql;
    await this.sql.unsafe(`create schema if not exists ${schema}`);
    await this.sql.unsafe(`
      create table if not exists ${schema}.schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    await this.sql.unsafe(`
      create table if not exists ${schema}.sessions (
        store_path text not null,
        session_key text not null,
        agent_id text,
        session_id text not null,
        updated_at bigint not null,
        payload jsonb not null,
        primary key (store_path, session_key)
      )
    `);
    await this.sql.unsafe(
      `create index if not exists sessions_agent_id_idx on ${schema}.sessions (agent_id, updated_at desc)`,
    );
    await this.sql.unsafe(`
      create table if not exists ${schema}.session_events (
        transcript_path text not null,
        agent_id text,
        session_id text not null,
        seq integer not null,
        entry_type text not null,
        payload jsonb not null,
        primary key (transcript_path, seq)
      )
    `);
    await this.sql.unsafe(
      `create index if not exists session_events_session_id_idx on ${schema}.session_events (session_id, seq)`,
    );
    await this.sql.unsafe(`
      create table if not exists ${schema}.subagent_runs (
        run_id text primary key,
        updated_at bigint not null,
        payload jsonb not null
      )
    `);
    await this.sql.unsafe(`
      create table if not exists ${schema}.auth_profiles (
        store_key text primary key,
        agent_scope text,
        updated_at bigint not null,
        payload jsonb not null
      )
    `);
    await this.sql.unsafe(`
      create table if not exists ${schema}.auth_secrets (
        store_key text not null,
        profile_id text not null,
        updated_at bigint not null,
        payload jsonb not null,
        primary key (store_key, profile_id)
      )
    `);
    await this.sql.unsafe(`
      create table if not exists ${schema}.memory_documents (
        workspace_root text not null,
        logical_path text not null,
        agent_id text,
        updated_at bigint not null,
        body text not null,
        meta jsonb not null default '{}'::jsonb,
        primary key (workspace_root, logical_path)
      )
    `);
    await this.sql.unsafe(`
      create table if not exists ${schema}.import_runs (
        run_id text primary key,
        mode text not null,
        dry_run boolean not null,
        status text not null,
        summary jsonb not null,
        started_at timestamptz not null default now(),
        finished_at timestamptz
      )
    `);
  }
}

let clientCacheKey: string | null = null;
let clientPromise: Promise<PostgresPersistenceClient | null> | null = null;

function buildClientCacheKey(config: ResolvedPostgresPersistenceConfig): string {
  return JSON.stringify({
    url: config.url,
    schema: config.schema,
    maxConnections: config.maxConnections,
    encryptionKey: config.encryptionKey ?? null,
    exportCompatibility: config.exportCompatibility,
  });
}

export async function getPostgresPersistence(): Promise<PostgresPersistenceClient | null> {
  return await getPostgresPersistenceWithMode("runtime");
}

async function closeClientPromiseBestEffort(
  promise: Promise<PostgresPersistenceClient | null> | null,
): Promise<void> {
  if (!promise) {
    return;
  }
  try {
    const resolved = await promise;
    await resolved?.close().catch(() => undefined);
  } catch {
    // Ignore initialization/close failures while draining replaced clients.
  }
}

async function getCachedPostgresPersistence(
  config: ResolvedPostgresPersistenceConfig | null,
): Promise<PostgresPersistenceClient | null> {
  if (!config) {
    const current = clientPromise;
    clientPromise = null;
    clientCacheKey = null;
    await closeClientPromiseBestEffort(current);
    return null;
  }

  const nextKey = buildClientCacheKey(config);
  if (clientPromise && clientCacheKey === nextKey) {
    return await clientPromise;
  }

  const previousClientPromise = clientPromise;
  const previousClientKey = clientCacheKey;
  if (previousClientPromise && previousClientKey !== nextKey) {
    clientPromise = null;
    clientCacheKey = null;
    await closeClientPromiseBestEffort(previousClientPromise);
  }

  clientCacheKey = nextKey;
  const pendingClientPromise = (async () => {
    const client = new PostgresPersistenceClient(config);
    try {
      await client.ensureReady();
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  })();
  clientPromise = pendingClientPromise;

  try {
    return await pendingClientPromise;
  } catch (error) {
    if (clientPromise === pendingClientPromise) {
      clientPromise = null;
      clientCacheKey = null;
    }
    throw error;
  }
}

export async function getPostgresPersistenceWithMode(
  mode: PostgresPersistenceLookupMode,
): Promise<PostgresPersistenceClient | null> {
  return await getCachedPostgresPersistence(await resolvePostgresPersistenceConfig(mode));
}

export async function getPostgresPersistenceForConfig(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  mode?: PostgresPersistenceLookupMode;
}): Promise<PostgresPersistenceClient | null> {
  return await getCachedPostgresPersistence(
    await resolvePostgresPersistenceConfigFromConfig(params),
  );
}

export async function resetPostgresPersistenceForTest(): Promise<void> {
  const current = clientPromise;
  clientPromise = null;
  clientCacheKey = null;
  await closeClientPromiseBestEffort(current);
}
