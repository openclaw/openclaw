import path from "node:path";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";

export const OPERATOR_MEMORY_COLLECTIONS = [
  "service-context",
  "task-outcomes",
  "contract-registry",
  "channel-events",
] as const;

const STORE_VERSION = 1 as const;
const APPEND_ONLY_COLLECTIONS = new Set<(typeof OPERATOR_MEMORY_COLLECTIONS)[number]>([
  "task-outcomes",
  "channel-events",
]);

const operatorMemoryMetadataSchema = z.object({
  source: z.string().trim().min(1),
  writer: z.string().trim().min(1),
  evidence_ref: z.string().trim().min(1),
  verified_at: z.number().int().positive(),
  ttl_policy: z.string().trim().min(1).optional(),
});

const operatorMemoryContentSchema = z.record(z.string(), z.unknown()).default({});

export const operatorMemoryPromotionSchema = z.object({
  collection: z.enum(
    OPERATOR_MEMORY_COLLECTIONS.filter((entry) => entry !== "service-context") as [
      "task-outcomes",
      "contract-registry",
      "channel-events",
    ],
  ),
  record_id: z.string().trim().min(1),
  scope_key: z.string().trim().min(1),
  content: operatorMemoryContentSchema,
  metadata: operatorMemoryMetadataSchema,
});

export const operatorServiceContextUpsertSchema = z.object({
  service: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  content: operatorMemoryContentSchema,
  metadata: operatorMemoryMetadataSchema,
});

export type OperatorMemoryCollection = (typeof OPERATOR_MEMORY_COLLECTIONS)[number];
export type OperatorMemoryPromotionInput = z.infer<typeof operatorMemoryPromotionSchema>;
export type OperatorServiceContextUpsertInput = z.infer<typeof operatorServiceContextUpsertSchema>;
export const OPERATOR_SHARED_MEMORY_AUTHORITY = "local-json-shim" as const;
export type OperatorSharedMemoryAuthority = typeof OPERATOR_SHARED_MEMORY_AUTHORITY;

export type OperatorMemoryRecord = {
  collection: OperatorMemoryCollection;
  recordId: string;
  scopeKey: string;
  summary: string | null;
  content: Record<string, unknown>;
  metadata: z.infer<typeof operatorMemoryMetadataSchema>;
  promotedAt: number;
};

type OperatorSharedMemoryStoreState = {
  version: 1;
  records: OperatorMemoryRecord[];
};

export type OperatorMemoryListFilters = {
  collection?: OperatorMemoryCollection | null;
  limit?: number;
};

type WriteResult = {
  created: boolean;
  record: OperatorMemoryRecord;
};

function createDefaultStore(): OperatorSharedMemoryStoreState {
  return {
    version: STORE_VERSION,
    records: [],
  };
}

function resolveMemoryStorePath(): string {
  return path.join(resolveStateDir(), "mission-control", "operator-shared-memory.json");
}

function loadStore(): OperatorSharedMemoryStoreState {
  const raw = loadJsonFile(resolveMemoryStorePath());
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { records?: unknown }).records)) {
    return createDefaultStore();
  }
  const parsed = raw as OperatorSharedMemoryStoreState;
  return parsed.version === STORE_VERSION ? parsed : createDefaultStore();
}

function saveStore(store: OperatorSharedMemoryStoreState): void {
  saveJsonFile(resolveMemoryStorePath(), store);
}

function normalizeRecord(record: OperatorMemoryRecord): OperatorMemoryRecord {
  return {
    collection: OPERATOR_MEMORY_COLLECTIONS.includes(record.collection)
      ? record.collection
      : "task-outcomes",
    recordId:
      typeof record.recordId === "string" && record.recordId.trim().length > 0
        ? record.recordId.trim()
        : `memory-${Math.random().toString(36).slice(2)}`,
    scopeKey:
      typeof record.scopeKey === "string" && record.scopeKey.trim().length > 0
        ? record.scopeKey.trim()
        : "unknown",
    summary:
      typeof record.summary === "string" && record.summary.trim().length > 0
        ? record.summary.trim()
        : null,
    content: record.content && typeof record.content === "object" ? record.content : {},
    metadata: operatorMemoryMetadataSchema.parse(record.metadata),
    promotedAt:
      typeof record.promotedAt === "number" && Number.isFinite(record.promotedAt)
        ? Math.round(record.promotedAt)
        : Date.now(),
  };
}

function buildRecord(input: {
  collection: OperatorMemoryCollection;
  recordId: string;
  scopeKey: string;
  summary?: string | null;
  content: Record<string, unknown>;
  metadata: z.infer<typeof operatorMemoryMetadataSchema>;
}): OperatorMemoryRecord {
  return {
    collection: input.collection,
    recordId: input.recordId,
    scopeKey: input.scopeKey,
    summary: input.summary?.trim() || null,
    content: input.content,
    metadata: input.metadata,
    promotedAt: Date.now(),
  };
}

function findByRecordId(
  store: OperatorSharedMemoryStoreState,
  collection: OperatorMemoryCollection,
  recordId: string,
): OperatorMemoryRecord | null {
  const match = store.records.find(
    (record) =>
      record.collection === collection &&
      record.recordId.toLowerCase() === recordId.trim().toLowerCase(),
  );
  return match ? normalizeRecord(match) : null;
}

function findByScopeKey(
  store: OperatorSharedMemoryStoreState,
  collection: OperatorMemoryCollection,
  scopeKey: string,
): { index: number; record: OperatorMemoryRecord } | null {
  const index = store.records.findIndex(
    (record) =>
      record.collection === collection &&
      record.scopeKey.toLowerCase() === scopeKey.trim().toLowerCase(),
  );
  if (index === -1) {
    return null;
  }
  return {
    index,
    record: normalizeRecord(store.records[index]),
  };
}

function replaceOrInsertRecord(
  store: OperatorSharedMemoryStoreState,
  next: OperatorMemoryRecord,
  existingIndex: number,
): void {
  if (existingIndex >= 0) {
    store.records.splice(existingIndex, 1);
  }
  store.records.unshift(next);
}

function assertNotStale(existing: OperatorMemoryRecord, verifiedAt: number): void {
  if (verifiedAt < existing.metadata.verified_at) {
    throw new Error(
      `stale memory update rejected for ${existing.collection}:${existing.scopeKey} (${verifiedAt} < ${existing.metadata.verified_at})`,
    );
  }
}

export function promoteOperatorMemory(input: unknown): WriteResult {
  const parsed = operatorMemoryPromotionSchema.parse(input);
  const store = loadStore();
  if (APPEND_ONLY_COLLECTIONS.has(parsed.collection)) {
    const existing = findByRecordId(store, parsed.collection, parsed.record_id);
    if (existing) {
      return {
        created: false,
        record: existing,
      };
    }
    const created = buildRecord({
      collection: parsed.collection,
      recordId: parsed.record_id,
      scopeKey: parsed.scope_key,
      content: parsed.content,
      metadata: parsed.metadata,
    });
    store.records.unshift(created);
    saveStore(store);
    return {
      created: true,
      record: created,
    };
  }

  const scoped = findByScopeKey(store, parsed.collection, parsed.scope_key);
  if (scoped) {
    assertNotStale(scoped.record, parsed.metadata.verified_at);
  }
  const next = buildRecord({
    collection: parsed.collection,
    recordId: parsed.record_id,
    scopeKey: parsed.scope_key,
    content: parsed.content,
    metadata: parsed.metadata,
  });
  replaceOrInsertRecord(store, next, scoped?.index ?? -1);
  saveStore(store);
  return {
    created: !scoped,
    record: next,
  };
}

export function upsertOperatorServiceContext(input: unknown): WriteResult {
  const parsed = operatorServiceContextUpsertSchema.parse(input);
  const store = loadStore();
  const existing = findByScopeKey(store, "service-context", parsed.service);
  if (existing) {
    assertNotStale(existing.record, parsed.metadata.verified_at);
  }
  const next = buildRecord({
    collection: "service-context",
    recordId: `service-context:${parsed.service}`,
    scopeKey: parsed.service,
    summary: parsed.summary,
    content: parsed.content,
    metadata: parsed.metadata,
  });
  replaceOrInsertRecord(store, next, existing?.index ?? -1);
  saveStore(store);
  return {
    created: !existing,
    record: next,
  };
}

export function listOperatorMemory(filters?: OperatorMemoryListFilters): {
  authority: OperatorSharedMemoryAuthority;
  storePath: string;
  generatedAt: number;
  collections: Record<
    OperatorMemoryCollection,
    {
      count: number;
      lastVerifiedAt: number | null;
      writeMode: "append-only" | "upsert";
    }
  >;
  records: OperatorMemoryRecord[];
} {
  const store = loadStore();
  const normalized = store.records.map(normalizeRecord);
  const limit = Math.min(200, Math.max(1, Math.round(filters?.limit ?? 50)));
  const filtered = filters?.collection
    ? normalized.filter((record) => record.collection === filters.collection)
    : normalized;
  const collections = Object.fromEntries(
    OPERATOR_MEMORY_COLLECTIONS.map((collection) => {
      const records = normalized.filter((record) => record.collection === collection);
      return [
        collection,
        {
          count: records.length,
          lastVerifiedAt: records.reduce<number | null>(
            (latest, record) =>
              latest === null || record.metadata.verified_at > latest
                ? record.metadata.verified_at
                : latest,
            null,
          ),
          writeMode: APPEND_ONLY_COLLECTIONS.has(collection) ? "append-only" : "upsert",
        },
      ];
    }),
  ) as Record<
    OperatorMemoryCollection,
    {
      count: number;
      lastVerifiedAt: number | null;
      writeMode: "append-only" | "upsert";
    }
  >;

  return {
    authority: OPERATOR_SHARED_MEMORY_AUTHORITY,
    storePath: resolveMemoryStorePath(),
    generatedAt: Date.now(),
    collections,
    records: filtered.slice(0, limit),
  };
}

export function getOperatorMemoryStorePath(): string {
  return resolveMemoryStorePath();
}
