import { createHash } from "node:crypto";
import type {
  SessionStoreAdapter,
  SessionStoreEntryBatch,
  SessionStoreRecord,
} from "./storage-adapter.js";
import type { SessionEntry } from "./types.js";

export type SessionStoreAdapterMigrationMode = "dry-run" | "apply";

export type SessionStoreAdapterMigrationPlan = {
  sourceStorePath: string;
  destinationStorePath: string;
  sourceEntryCount: number;
  destinationEntryCountBefore: number;
  sourceChecksum: string;
  destinationChecksumBefore: string;
  keys: string[];
  conflictingKeys: string[];
};

export type SessionStoreAdapterMigrationResult = {
  mode: SessionStoreAdapterMigrationMode;
  applied: boolean;
  verified: boolean;
  rolledBack: boolean;
  plan: SessionStoreAdapterMigrationPlan;
};

export type SessionStoreMigrationMalformedEntry = {
  sessionKey: string;
  reason: string;
};

export type SessionStoreAdapterMigrationCheckpoint = {
  sourceStorePath: string;
  destinationStorePath: string;
  sourceEntryCount: number;
  sourceChecksum: string;
  batchSize: number;
  nextOffset: number;
  batchesApplied: number;
  entriesWritten: number;
  appliedKeys: string[];
  completed: boolean;
};

export type ChunkedSessionStoreAdapterMigrationResult = SessionStoreAdapterMigrationResult & {
  batchSize: number;
  batchesApplied: number;
  entriesWritten: number;
  checkpoint: SessionStoreAdapterMigrationCheckpoint;
  malformedEntries: SessionStoreMigrationMalformedEntry[];
};

export type SessionStoreAdapterMigrationOptions = {
  sourceAdapter: SessionStoreAdapter;
  destinationAdapter: SessionStoreAdapter;
  sourceStorePath: string;
  destinationStorePath: string;
  mode?: SessionStoreAdapterMigrationMode;
  allowSamePath?: boolean;
  verifyAfterWrite?: boolean;
  rollbackOnError?: boolean;
};

export type ChunkedSessionStoreAdapterMigrationOptions = SessionStoreAdapterMigrationOptions & {
  batchSize: number;
  checkpoint?: SessionStoreAdapterMigrationCheckpoint;
  onCheckpoint?: (checkpoint: SessionStoreAdapterMigrationCheckpoint) => void | Promise<void>;
  skipMalformed?: boolean;
  allowNonEmptyDestination?: boolean;
};

export class SessionStoreAdapterMigrationError extends Error {
  readonly plan: SessionStoreAdapterMigrationPlan;
  readonly rolledBack: boolean;

  constructor(
    message: string,
    params: { plan: SessionStoreAdapterMigrationPlan; rolledBack: boolean },
  ) {
    super(message);
    this.name = "SessionStoreAdapterMigrationError";
    this.plan = params.plan;
    this.rolledBack = params.rolledBack;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

export function checksumSessionStoreRecord(store: SessionStoreRecord): string {
  return createHash("sha256").update(stableJson(store)).digest("hex");
}

function sortedKeys(store: SessionStoreRecord): string[] {
  return Object.keys(store).toSorted((left, right) => left.localeCompare(right));
}

function normalizeBatchSize(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("batchSize must be finite");
  }
  const normalized = Math.floor(value);
  if (normalized < 1) {
    throw new Error("batchSize must be at least 1");
  }
  return normalized;
}

function validateSessionEntry(
  sessionKey: string,
  entry: SessionEntry,
): SessionStoreMigrationMalformedEntry | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { sessionKey, reason: "entry is not an object" };
  }
  if (typeof entry.sessionId !== "string" || entry.sessionId.length === 0) {
    return { sessionKey, reason: "entry.sessionId must be a non-empty string" };
  }
  if (typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt)) {
    return { sessionKey, reason: "entry.updatedAt must be a finite number" };
  }
  return undefined;
}

async function writeSessionEntries(
  adapter: SessionStoreAdapter,
  storePath: string,
  entries: SessionStoreEntryBatch,
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  if (adapter.writeEntries) {
    await adapter.writeEntries(storePath, entries, { skipMaintenance: true });
    return;
  }
  await adapter.updateStore(
    storePath,
    (store) => {
      for (const [sessionKey, entry] of entries) {
        store[sessionKey] = structuredClone(entry);
      }
    },
    { skipMaintenance: true },
  );
}

function buildCheckpoint(params: {
  plan: SessionStoreAdapterMigrationPlan;
  batchSize: number;
  nextOffset: number;
  batchesApplied: number;
  entriesWritten: number;
  appliedKeys: string[];
  completed: boolean;
}): SessionStoreAdapterMigrationCheckpoint {
  return {
    sourceStorePath: params.plan.sourceStorePath,
    destinationStorePath: params.plan.destinationStorePath,
    sourceEntryCount: params.plan.sourceEntryCount,
    sourceChecksum: params.plan.sourceChecksum,
    batchSize: params.batchSize,
    nextOffset: params.nextOffset,
    batchesApplied: params.batchesApplied,
    entriesWritten: params.entriesWritten,
    appliedKeys: [...params.appliedKeys],
    completed: params.completed,
  };
}

function assertResumeCheckpointMatches(
  checkpoint: SessionStoreAdapterMigrationCheckpoint,
  plan: SessionStoreAdapterMigrationPlan,
  batchSize: number,
): void {
  if (
    checkpoint.sourceStorePath !== plan.sourceStorePath ||
    checkpoint.destinationStorePath !== plan.destinationStorePath ||
    checkpoint.sourceEntryCount !== plan.sourceEntryCount ||
    checkpoint.sourceChecksum !== plan.sourceChecksum ||
    checkpoint.batchSize !== batchSize
  ) {
    throw new Error("Migration checkpoint does not match current source/destination plan");
  }
}

function buildMigrationPlan(params: {
  sourceStorePath: string;
  destinationStorePath: string;
  source: SessionStoreRecord;
  destinationBefore: SessionStoreRecord;
}): SessionStoreAdapterMigrationPlan {
  const keys = sortedKeys(params.source);
  const destinationKeys = new Set(Object.keys(params.destinationBefore));
  const conflictingKeys = keys.filter((key) => destinationKeys.has(key));
  return {
    sourceStorePath: params.sourceStorePath,
    destinationStorePath: params.destinationStorePath,
    sourceEntryCount: keys.length,
    destinationEntryCountBefore: Object.keys(params.destinationBefore).length,
    sourceChecksum: checksumSessionStoreRecord(params.source),
    destinationChecksumBefore: checksumSessionStoreRecord(params.destinationBefore),
    keys,
    conflictingKeys,
  };
}

export async function planSessionStoreAdapterMigration(
  options: SessionStoreAdapterMigrationOptions,
): Promise<SessionStoreAdapterMigrationPlan> {
  if (!options.allowSamePath && options.sourceStorePath === options.destinationStorePath) {
    throw new Error("Refusing to migrate a session store onto itself");
  }
  const [source, destinationBefore] = await Promise.all([
    options.sourceAdapter.loadStore(options.sourceStorePath),
    options.destinationAdapter.loadStore(options.destinationStorePath),
  ]);
  return buildMigrationPlan({
    sourceStorePath: options.sourceStorePath,
    destinationStorePath: options.destinationStorePath,
    source,
    destinationBefore,
  });
}

export async function migrateSessionStoreAdapter(
  options: SessionStoreAdapterMigrationOptions,
): Promise<SessionStoreAdapterMigrationResult> {
  const mode = options.mode ?? "dry-run";
  if (!options.allowSamePath && options.sourceStorePath === options.destinationStorePath) {
    throw new Error("Refusing to migrate a session store onto itself");
  }
  const source = await options.sourceAdapter.loadStore(options.sourceStorePath);
  const destinationBefore = await options.destinationAdapter.loadStore(
    options.destinationStorePath,
  );
  const plan = buildMigrationPlan({
    sourceStorePath: options.sourceStorePath,
    destinationStorePath: options.destinationStorePath,
    source,
    destinationBefore,
  });

  if (mode === "dry-run") {
    return { mode, applied: false, verified: false, rolledBack: false, plan };
  }

  let rolledBack = false;
  try {
    await options.destinationAdapter.saveStore(options.destinationStorePath, source, {
      skipMaintenance: true,
    });
    if (options.verifyAfterWrite !== false) {
      const destinationAfter = await options.destinationAdapter.loadStore(
        options.destinationStorePath,
      );
      const destinationAfterChecksum = checksumSessionStoreRecord(destinationAfter);
      if (destinationAfterChecksum !== plan.sourceChecksum) {
        throw new Error("Post-migration destination checksum did not match source checksum");
      }
    }
    return { mode, applied: true, verified: options.verifyAfterWrite !== false, rolledBack, plan };
  } catch (error) {
    if (options.rollbackOnError !== false) {
      try {
        await options.destinationAdapter.saveStore(
          options.destinationStorePath,
          destinationBefore,
          {
            skipMaintenance: true,
          },
        );
        rolledBack = true;
      } catch (rollbackError) {
        const detail = error instanceof Error ? `: ${error.message}` : "";
        const rollbackDetail =
          rollbackError instanceof Error ? `; rollback failed: ${rollbackError.message}` : "";
        throw new SessionStoreAdapterMigrationError(
          `Session store migration failed${detail}${rollbackDetail}`,
          {
            plan,
            rolledBack,
          },
        );
      }
    }
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new SessionStoreAdapterMigrationError(`Session store migration failed${detail}`, {
      plan,
      rolledBack,
    });
  }
}

export async function migrateSessionStoreAdapterInBatches(
  options: ChunkedSessionStoreAdapterMigrationOptions,
): Promise<ChunkedSessionStoreAdapterMigrationResult> {
  const mode = options.mode ?? "dry-run";
  const batchSize = normalizeBatchSize(options.batchSize);
  if (!options.allowSamePath && options.sourceStorePath === options.destinationStorePath) {
    throw new Error("Refusing to migrate a session store onto itself");
  }
  const [source, destinationBefore] = await Promise.all([
    options.sourceAdapter.loadStore(options.sourceStorePath),
    options.destinationAdapter.loadStore(options.destinationStorePath),
  ]);
  const plan = buildMigrationPlan({
    sourceStorePath: options.sourceStorePath,
    destinationStorePath: options.destinationStorePath,
    source,
    destinationBefore,
  });
  if (options.checkpoint) {
    assertResumeCheckpointMatches(options.checkpoint, plan, batchSize);
  }
  if (
    mode === "apply" &&
    !options.checkpoint &&
    options.allowNonEmptyDestination !== true &&
    Object.keys(destinationBefore).length > 0
  ) {
    throw new Error(
      "Refusing chunked session store migration into a non-empty destination without allowNonEmptyDestination",
    );
  }

  const malformedEntries: SessionStoreMigrationMalformedEntry[] = [];
  const expectedDestination: SessionStoreRecord = {};
  let nextOffset = options.checkpoint?.nextOffset ?? 0;
  let batchesApplied = options.checkpoint?.batchesApplied ?? 0;
  let entriesWritten = options.checkpoint?.entriesWritten ?? 0;
  const appliedKeys = [...(options.checkpoint?.appliedKeys ?? [])];

  if (mode === "dry-run") {
    for (const [sessionKey, entry] of Object.entries(source)) {
      const malformed = validateSessionEntry(sessionKey, entry);
      if (malformed) {
        malformedEntries.push(malformed);
      }
    }
    return {
      mode,
      applied: false,
      verified: false,
      rolledBack: false,
      plan,
      batchSize,
      batchesApplied: 0,
      entriesWritten: 0,
      checkpoint: buildCheckpoint({
        plan,
        batchSize,
        nextOffset: 0,
        batchesApplied: 0,
        entriesWritten: 0,
        appliedKeys: [],
        completed: false,
      }),
      malformedEntries,
    };
  }

  let rolledBack = false;
  try {
    for (;;) {
      const page = await options.sourceAdapter.listEntries(options.sourceStorePath, {
        limit: batchSize,
        offset: nextOffset,
        orderBy: "key_asc",
      });
      const validEntries: Array<[string, SessionEntry]> = [];
      for (const [sessionKey, entry] of page.entries) {
        const malformed = validateSessionEntry(sessionKey, entry);
        if (malformed) {
          malformedEntries.push(malformed);
          continue;
        }
        validEntries.push([sessionKey, entry]);
        expectedDestination[sessionKey] = structuredClone(entry);
      }
      if (malformedEntries.length > 0 && options.skipMalformed !== true) {
        throw new Error(
          `Migration encountered ${malformedEntries.length} malformed session entr${malformedEntries.length === 1 ? "y" : "ies"}`,
        );
      }
      await writeSessionEntries(
        options.destinationAdapter,
        options.destinationStorePath,
        validEntries,
      );
      entriesWritten += validEntries.length;
      appliedKeys.push(...validEntries.map(([sessionKey]) => sessionKey));
      batchesApplied += 1;
      nextOffset = page.nextOffset ?? page.totalCount;
      const checkpoint = buildCheckpoint({
        plan,
        batchSize,
        nextOffset,
        batchesApplied,
        entriesWritten,
        appliedKeys,
        completed: !page.hasMore,
      });
      await options.onCheckpoint?.(checkpoint);
      if (!page.hasMore) {
        break;
      }
    }

    if (options.verifyAfterWrite !== false) {
      for (const [sessionKey, expectedEntry] of Object.entries(expectedDestination)) {
        const destinationEntry = await options.destinationAdapter.readEntry(
          options.destinationStorePath,
          sessionKey,
        );
        if (stableJson(destinationEntry) !== stableJson(expectedEntry)) {
          throw new Error(`Post-migration destination entry mismatch for ${sessionKey}`);
        }
      }
    }
    return {
      mode,
      applied: true,
      verified: options.verifyAfterWrite !== false,
      rolledBack,
      plan,
      batchSize,
      batchesApplied,
      entriesWritten,
      checkpoint: buildCheckpoint({
        plan,
        batchSize,
        nextOffset,
        batchesApplied,
        entriesWritten,
        appliedKeys,
        completed: true,
      }),
      malformedEntries,
    };
  } catch (error) {
    if (options.rollbackOnError !== false) {
      try {
        await options.destinationAdapter.saveStore(
          options.destinationStorePath,
          destinationBefore,
          { skipMaintenance: true },
        );
        rolledBack = true;
      } catch (rollbackError) {
        const detail = error instanceof Error ? `: ${error.message}` : "";
        const rollbackDetail =
          rollbackError instanceof Error ? `; rollback failed: ${rollbackError.message}` : "";
        throw new SessionStoreAdapterMigrationError(
          `Chunked session store migration failed${detail}${rollbackDetail}`,
          { plan, rolledBack },
        );
      }
    }
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new SessionStoreAdapterMigrationError(`Chunked session store migration failed${detail}`, {
      plan,
      rolledBack,
    });
  }
}
