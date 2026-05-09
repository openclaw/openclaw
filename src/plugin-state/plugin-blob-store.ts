import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { OpenKeyedStoreOptions } from "./plugin-state-store.types.js";

export type PluginBlobEntry<TMetadata = Record<string, unknown>> = {
  key: string;
  metadata: TMetadata;
  blob: Buffer;
  createdAt: number;
  expiresAt?: number;
};

export type PluginBlobStore<TMetadata = Record<string, unknown>> = {
  register(
    key: string,
    metadata: TMetadata,
    blob: Buffer,
    opts?: { ttlMs?: number },
  ): Promise<void>;
  lookup(key: string): Promise<PluginBlobEntry<TMetadata> | undefined>;
  consume(key: string): Promise<PluginBlobEntry<TMetadata> | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<PluginBlobEntry<TMetadata>[]>;
  clear(): Promise<void>;
};

export type PluginBlobSyncStore<TMetadata = Record<string, unknown>> = {
  register(key: string, metadata: TMetadata, blob: Buffer, opts?: { ttlMs?: number }): void;
  lookup(key: string): PluginBlobEntry<TMetadata> | undefined;
  consume(key: string): PluginBlobEntry<TMetadata> | undefined;
  delete(key: string): boolean;
  entries(): PluginBlobEntry<TMetadata>[];
  clear(): void;
};

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;
const MAX_NAMESPACE_BYTES = 128;
const MAX_KEY_BYTES = 512;
const textEncoder = new TextEncoder();

type PluginBlobEntriesTable = OpenClawStateKyselyDatabase["plugin_blob_entries"];

type BlobRow = Pick<
  Selectable<PluginBlobEntriesTable>,
  "blob" | "created_at" | "entry_key" | "expires_at" | "metadata_json"
>;

type BlobStoreOptionSignature = {
  maxEntries: number;
  defaultTtlMs?: number;
};

type PluginBlobDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_blob_entries">;

const namespaceOptionSignatures = new Map<string, BlobStoreOptionSignature>();

function assertMaxBytes(label: string, value: string, max: number): void {
  if (textEncoder.encode(value).byteLength > max) {
    throw new Error(`plugin blob ${label} must be <= ${max} bytes`);
  }
}

function validateNamespace(value: string): string {
  const trimmed = value.trim();
  if (!NAMESPACE_PATTERN.test(trimmed)) {
    throw new Error(`plugin blob namespace must be a safe path segment: ${value}`);
  }
  assertMaxBytes("namespace", trimmed, MAX_NAMESPACE_BYTES);
  return trimmed;
}

function validateKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("plugin blob entry key must not be empty");
  }
  assertMaxBytes("entry key", trimmed, MAX_KEY_BYTES);
  return trimmed;
}

function validateMaxEntries(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("plugin blob maxEntries must be an integer >= 1");
  }
  return value;
}

function validateOptionalTtlMs(value: number | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("plugin blob ttlMs must be a positive integer");
  }
  return value;
}

function assertJsonMetadata(value: unknown): string {
  if (value === undefined) {
    throw new Error("plugin blob metadata must be JSON-serializable");
  }
  return JSON.stringify(value);
}

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function assertConsistentOptions(
  pluginId: string,
  namespace: string,
  signature: BlobStoreOptionSignature,
): void {
  const key = `${pluginId}\0${namespace}`;
  const existing = namespaceOptionSignatures.get(key);
  if (!existing) {
    namespaceOptionSignatures.set(key, signature);
    return;
  }
  if (
    existing.maxEntries !== signature.maxEntries ||
    existing.defaultTtlMs !== signature.defaultTtlMs
  ) {
    throw new Error(
      `plugin blob namespace ${namespace} for ${pluginId} was reopened with incompatible options`,
    );
  }
}

function rowToEntry<TMetadata>(row: BlobRow): PluginBlobEntry<TMetadata> {
  const expiresAt = normalizeNumber(row.expires_at);
  return {
    key: row.entry_key,
    metadata: JSON.parse(row.metadata_json) as TMetadata,
    blob: Buffer.from(row.blob),
    createdAt: normalizeNumber(row.created_at) ?? 0,
    ...(expiresAt != null ? { expiresAt } : {}),
  };
}

function getPluginBlobKysely(db: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<PluginBlobDatabase>(db);
}

export function createPluginBlobStore<TMetadata = Record<string, unknown>>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): PluginBlobStore<TMetadata> {
  const syncStore = createPluginBlobSyncStore<TMetadata>(pluginId, options);
  return {
    async register(key, metadata, blob, opts) {
      syncStore.register(key, metadata, blob, opts);
    },
    async lookup(key) {
      return syncStore.lookup(key);
    },
    async consume(key) {
      return syncStore.consume(key);
    },
    async delete(key) {
      return syncStore.delete(key);
    },
    async entries() {
      return syncStore.entries();
    },
    async clear() {
      syncStore.clear();
    },
  };
}

export function createPluginBlobSyncStore<TMetadata = Record<string, unknown>>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): PluginBlobSyncStore<TMetadata> {
  if (pluginId.startsWith("core:")) {
    throw new Error("Plugin ids starting with 'core:' are reserved for core consumers.");
  }
  const namespace = validateNamespace(options.namespace);
  const maxEntries = validateMaxEntries(options.maxEntries);
  const defaultTtlMs = validateOptionalTtlMs(options.defaultTtlMs);
  assertConsistentOptions(pluginId, namespace, { maxEntries, defaultTtlMs });

  const now = () => Date.now();

  return {
    register(key, metadata, blob, opts) {
      const normalizedKey = validateKey(key);
      const metadataJson = assertJsonMetadata(metadata);
      const createdAt = now();
      const ttlMs = validateOptionalTtlMs(opts?.ttlMs) ?? defaultTtlMs;
      const expiresAt = ttlMs == null ? null : createdAt + ttlMs;
      runOpenClawStateWriteTransaction((database) => {
        const db = getPluginBlobKysely(database.db);
        executeSqliteQuerySync(
          database.db,
          db
            .insertInto("plugin_blob_entries")
            .values({
              plugin_id: pluginId,
              namespace,
              entry_key: normalizedKey,
              metadata_json: metadataJson,
              blob,
              created_at: createdAt,
              expires_at: expiresAt,
            })
            .onConflict((conflict) =>
              conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
                metadata_json: (eb) => eb.ref("excluded.metadata_json"),
                blob: (eb) => eb.ref("excluded.blob"),
                created_at: (eb) => eb.ref("excluded.created_at"),
                expires_at: (eb) => eb.ref("excluded.expires_at"),
              }),
            ),
        );

        executeSqliteQuerySync(
          database.db,
          db
            .deleteFrom("plugin_blob_entries")
            .where("plugin_id", "=", pluginId)
            .where("namespace", "=", namespace)
            .where("expires_at", "is not", null)
            .where("expires_at", "<=", createdAt),
        );

        const countRow = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("plugin_blob_entries")
            .select((eb) => eb.fn.countAll<number | bigint>().as("count"))
            .where("plugin_id", "=", pluginId)
            .where("namespace", "=", namespace)
            .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", createdAt)])),
        );
        const count = Number(countRow?.count ?? 0);
        const overflow = count - maxEntries;
        if (overflow > 0) {
          const overflowRows = executeSqliteQuerySync(
            database.db,
            db
              .selectFrom("plugin_blob_entries")
              .select("entry_key")
              .where("plugin_id", "=", pluginId)
              .where("namespace", "=", namespace)
              .where("entry_key", "<>", normalizedKey)
              .where((eb) =>
                eb.or([eb("expires_at", "is", null), eb("expires_at", ">", createdAt)]),
              )
              .orderBy("created_at", "asc")
              .orderBy("entry_key", "asc")
              .limit(overflow),
          ).rows;
          if (overflowRows.length > 0) {
            executeSqliteQuerySync(
              database.db,
              db
                .deleteFrom("plugin_blob_entries")
                .where("plugin_id", "=", pluginId)
                .where("namespace", "=", namespace)
                .where(
                  "entry_key",
                  "in",
                  overflowRows.map((row) => row.entry_key),
                ),
            );
          }
        }
      });
    },
    lookup(key) {
      const normalizedKey = validateKey(key);
      const database = openOpenClawStateDatabase();
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        getPluginBlobKysely(database.db)
          .selectFrom("plugin_blob_entries")
          .select(["entry_key", "metadata_json", "blob", "created_at", "expires_at"])
          .where("plugin_id", "=", pluginId)
          .where("namespace", "=", namespace)
          .where("entry_key", "=", normalizedKey)
          .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now())])),
      );
      return row ? rowToEntry<TMetadata>(row) : undefined;
    },
    consume(key) {
      const normalizedKey = validateKey(key);
      const row = runOpenClawStateWriteTransaction((database) => {
        const db = getPluginBlobKysely(database.db);
        const found = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("plugin_blob_entries")
            .select(["entry_key", "metadata_json", "blob", "created_at", "expires_at"])
            .where("plugin_id", "=", pluginId)
            .where("namespace", "=", namespace)
            .where("entry_key", "=", normalizedKey)
            .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now())])),
        );
        executeSqliteQuerySync(
          database.db,
          db
            .deleteFrom("plugin_blob_entries")
            .where("plugin_id", "=", pluginId)
            .where("namespace", "=", namespace)
            .where("entry_key", "=", normalizedKey),
        );
        return found;
      });
      return row ? rowToEntry<TMetadata>(row) : undefined;
    },
    delete(key) {
      const normalizedKey = validateKey(key);
      const result = runOpenClawStateWriteTransaction((database) =>
        executeSqliteQuerySync(
          database.db,
          getPluginBlobKysely(database.db)
            .deleteFrom("plugin_blob_entries")
            .where("plugin_id", "=", pluginId)
            .where("namespace", "=", namespace)
            .where("entry_key", "=", normalizedKey),
        ),
      );
      return Number(result.numAffectedRows ?? 0) > 0;
    },
    entries() {
      const database = openOpenClawStateDatabase();
      const rows = executeSqliteQuerySync(
        database.db,
        getPluginBlobKysely(database.db)
          .selectFrom("plugin_blob_entries")
          .select(["entry_key", "metadata_json", "blob", "created_at", "expires_at"])
          .where("plugin_id", "=", pluginId)
          .where("namespace", "=", namespace)
          .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now())]))
          .orderBy("created_at", "asc")
          .orderBy("entry_key", "asc"),
      ).rows;
      return rows.map((row) => rowToEntry<TMetadata>(row));
    },
    clear() {
      runOpenClawStateWriteTransaction((database) => {
        executeSqliteQuerySync(
          database.db,
          getPluginBlobKysely(database.db)
            .deleteFrom("plugin_blob_entries")
            .where("plugin_id", "=", pluginId)
            .where("namespace", "=", namespace),
        );
      });
    },
  };
}

export function resetPluginBlobStoreForTests(): void {
  namespaceOptionSignatures.clear();
  closeOpenClawStateDatabaseForTest();
}
