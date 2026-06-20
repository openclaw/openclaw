import { jsonSessionStoreAdapter } from "./json-store-adapter.js";
import {
  createPostgresSessionStoreAdapter,
  type PostgresSessionStoreQueryClient,
} from "./postgres-store-adapter.js";
import type {
  SessionStoreAdapter,
  SessionStoreListOptions,
  SessionStoreMutationOptions,
  SessionStoreRecord,
} from "./storage-adapter.js";
import type { SessionEntry } from "./types.js";

export const SESSION_STORE_BACKEND_ENV = "OPENCLAW_SESSION_STORE_BACKEND";
export const SESSION_STORE_TENANT_ID_ENV = "OPENCLAW_SESSION_STORE_TENANT_ID";
export const SESSION_STORE_GATEWAY_ID_ENV = "OPENCLAW_SESSION_STORE_GATEWAY_ID";
export const SESSION_STORE_SCHEMA_ENV = "OPENCLAW_SESSION_STORE_SCHEMA";

export type SessionStoreBackendConfig =
  | { backend: "json" }
  | { backend: "postgres"; tenantId: string; gatewayId: string; schema?: string };

export type ResolveSessionStoreAdapterOptions = {
  env?: Record<string, string | undefined>;
  postgresClient?: PostgresSessionStoreQueryClient;
};

export type SessionStoreRuntimeAdapterFactory = (
  config: SessionStoreBackendConfig,
) => SessionStoreAdapter | undefined;

export class SessionStoreBackendConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStoreBackendConfigError";
  }
}

let runtimeAdapterFactory: SessionStoreRuntimeAdapterFactory | undefined;

export function configureSessionStoreRuntimeAdapterFactory(
  factory: SessionStoreRuntimeAdapterFactory,
): () => void {
  const previous = runtimeAdapterFactory;
  runtimeAdapterFactory = factory;
  return () => {
    runtimeAdapterFactory = previous;
  };
}

export function clearSessionStoreRuntimeAdapterFactory(): void {
  runtimeAdapterFactory = undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireString(value: string | undefined, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new SessionStoreBackendConfigError(`${label} is required for postgres session store`);
  }
  return normalized;
}

function normalizeBackend(value: string | undefined): "json" | "postgres" {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized === undefined || normalized === "json") {
    return "json";
  }
  if (normalized === "postgres" || normalized === "postgresql") {
    return "postgres";
  }
  throw new SessionStoreBackendConfigError(`Unsupported session store backend: ${value}`);
}

export function readSessionStoreBackendConfig(
  env: Record<string, string | undefined> = process.env,
): SessionStoreBackendConfig {
  const backend = normalizeBackend(env[SESSION_STORE_BACKEND_ENV]);
  if (backend === "json") {
    return { backend };
  }
  return {
    backend,
    tenantId: requireString(env[SESSION_STORE_TENANT_ID_ENV], SESSION_STORE_TENANT_ID_ENV),
    gatewayId: requireString(env[SESSION_STORE_GATEWAY_ID_ENV], SESSION_STORE_GATEWAY_ID_ENV),
    schema: normalizeOptionalString(env[SESSION_STORE_SCHEMA_ENV]),
  };
}

export function resolveSessionStoreAdapter(
  options: ResolveSessionStoreAdapterOptions = {},
): SessionStoreAdapter {
  const config = readSessionStoreBackendConfig(options.env);
  const runtimeAdapter = runtimeAdapterFactory?.(config);
  if (runtimeAdapter) {
    if (config.backend === "json" && runtimeAdapter.kind !== "json") {
      throw new SessionStoreBackendConfigError(
        `Runtime session store adapter kind "${runtimeAdapter.kind}" does not match configured backend "json"`,
      );
    }
    if (config.backend === "postgres" && runtimeAdapter.kind !== "postgres") {
      throw new SessionStoreBackendConfigError(
        `Runtime session store adapter kind "${runtimeAdapter.kind}" does not match configured backend "postgres"`,
      );
    }
    return runtimeAdapter;
  }
  if (config.backend === "json") {
    return jsonSessionStoreAdapter;
  }
  if (!options.postgresClient) {
    throw new SessionStoreBackendConfigError(
      "Postgres session store requires an injected dedicated OpenClaw session-store query client; refusing to reuse an implicit CMS/Payload/Supabase pool",
    );
  }
  return createPostgresSessionStoreAdapter(options.postgresClient, {
    tenantId: config.tenantId,
    gatewayId: config.gatewayId,
    schema: config.schema,
  });
}

export async function loadSessionStoreAsync(storePath: string): Promise<SessionStoreRecord> {
  return await resolveSessionStoreAdapter().loadStore(storePath);
}

export async function readSessionEntryAsync(
  storePath: string,
  sessionKey: string,
): Promise<SessionEntry | undefined> {
  return await resolveSessionStoreAdapter().readEntry(storePath, sessionKey);
}

export async function listSessionEntriesAsync(
  storePath: string,
  options?: SessionStoreListOptions,
) {
  return await resolveSessionStoreAdapter().listEntries(storePath, options);
}

export async function saveSessionStoreAsync(
  storePath: string,
  store: SessionStoreRecord,
  options?: SessionStoreMutationOptions,
): Promise<void> {
  await resolveSessionStoreAdapter().saveStore(storePath, store, options);
}

export async function updateSessionStoreAsync<T>(
  storePath: string,
  mutator: (store: SessionStoreRecord) => T | Promise<T>,
  options?: SessionStoreMutationOptions,
): Promise<T> {
  return await resolveSessionStoreAdapter().updateStore(storePath, mutator, options);
}
