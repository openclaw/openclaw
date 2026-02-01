import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EMBEDDING_CACHE_TABLE, FTS_TABLE, VECTOR_TABLE } from "./constants.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import {
  calculateImportanceScore,
  scoreToImportance,
  recordChunkAccess,
  initializeChunkTimestamps,
  updateImportanceScores,
  pinChunk,
  unpinChunk,
  setChunkImportance,
  getPruneCandidates,
  pruneChunks,
  enforceStorageLimits,
  getRetentionStats,
  ensureRetentionSchema,
  DEFAULT_RETENTION_POLICY,
  type RetentionPolicy,
  type MemoryImportance,
} from "./retention.js";

// Helper to create a test database with retention schema
function createTestDb() {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");

  // First ensure base schema
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: EMBEDDING_CACHE_TABLE,
    ftsTable: FTS_TABLE,
    ftsEnabled: false,
  });

  // Then add retention schema
  ensureRetentionSchema(db);

  return db;
}

// Helper to insert a test chunk
function insertChunk(
  db: ReturnType<typeof createTestDb>,
  params: {
    id: string;
    path?: string;
    source?: "memory" | "sessions";
    text?: string;
    createdAt?: number;
    lastAccessedAt?: number;
    accessCount?: number;
    importance?: MemoryImportance;
    importanceScore?: number;
    pinned?: boolean;
  },
) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO chunks (
      id, path, source, start_line, end_line, hash, model, text, embedding,
      created_at, last_accessed_at, access_count, importance, importance_score, pinned, tags, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.path ?? "test.md",
    params.source ?? "memory",
    1,
    10,
    `hash-${params.id}`,
    "test-model",
    params.text ?? `Test content for ${params.id}`,
    "[]",
    params.createdAt ?? now,
    params.lastAccessedAt ?? now,
    params.accessCount ?? 0,
    params.importance ?? "normal",
    params.importanceScore ?? 0.5,
    params.pinned ? 1 : 0,
    "[]",
    now,
  );
}

describe("calculateImportanceScore", () => {
  const baseParams = {
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    source: "memory" as const,
    importance: "normal" as const,
    pinned: false,
    policy: DEFAULT_RETENTION_POLICY,
  };

  it("returns 1.0 for pinned items", () => {
    const score = calculateImportanceScore({
      ...baseParams,
      pinned: true,
    });
    expect(score).toBe(1.0);
  });

  it("gives higher score to recent items", () => {
    const now = Date.now();
    const recentScore = calculateImportanceScore({
      ...baseParams,
      createdAt: now,
      now,
    });

    const oldScore = calculateImportanceScore({
      ...baseParams,
      createdAt: now - 60 * 24 * 60 * 60 * 1000, // 60 days ago
      now,
    });

    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it("gives higher score to frequently accessed items", () => {
    const lowAccessScore = calculateImportanceScore({
      ...baseParams,
      accessCount: 1,
    });

    const highAccessScore = calculateImportanceScore({
      ...baseParams,
      accessCount: 100,
    });

    expect(highAccessScore).toBeGreaterThan(lowAccessScore);
  });

  it("gives higher score to memory source vs sessions", () => {
    const memoryScore = calculateImportanceScore({
      ...baseParams,
      source: "memory",
    });

    const sessionScore = calculateImportanceScore({
      ...baseParams,
      source: "sessions",
    });

    expect(memoryScore).toBeGreaterThan(sessionScore);
  });

  it("respects explicit importance levels", () => {
    const criticalScore = calculateImportanceScore({
      ...baseParams,
      importance: "critical",
    });

    const lowScore = calculateImportanceScore({
      ...baseParams,
      importance: "low",
    });

    expect(criticalScore).toBeGreaterThan(lowScore);
  });

  it("applies decay for inactive items", () => {
    const now = Date.now();
    const activeScore = calculateImportanceScore({
      ...baseParams,
      lastAccessedAt: now,
      now,
    });

    const inactiveScore = calculateImportanceScore({
      ...baseParams,
      lastAccessedAt: now - 30 * 24 * 60 * 60 * 1000, // 30 days ago
      now,
    });

    expect(activeScore).toBeGreaterThan(inactiveScore);
  });

  it("clamps score between 0 and 1", () => {
    const score = calculateImportanceScore({
      ...baseParams,
      importance: "critical",
      accessCount: 1000,
    });

    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("scoreToImportance", () => {
  it("maps high scores to critical", () => {
    expect(scoreToImportance(0.95)).toBe("critical");
    expect(scoreToImportance(1.0)).toBe("critical");
  });

  it("maps medium-high scores to high", () => {
    expect(scoreToImportance(0.75)).toBe("high");
    expect(scoreToImportance(0.85)).toBe("high");
  });

  it("maps medium scores to normal", () => {
    expect(scoreToImportance(0.5)).toBe("normal");
    expect(scoreToImportance(0.6)).toBe("normal");
  });

  it("maps low scores to low", () => {
    expect(scoreToImportance(0.25)).toBe("low");
    expect(scoreToImportance(0.35)).toBe("low");
  });

  it("maps very low scores to archive", () => {
    expect(scoreToImportance(0.1)).toBe("archive");
    expect(scoreToImportance(0.05)).toBe("archive");
  });
});

describe("recordChunkAccess", () => {
  it("updates access count and timestamp", () => {
    const db = createTestDb();
    const now = Date.now();

    insertChunk(db, {
      id: "chunk1",
      accessCount: 0,
      lastAccessedAt: now - 10000,
    });

    recordChunkAccess(db, ["chunk1"], now);

    const chunk = db
      .prepare(`
      SELECT access_count, last_accessed_at FROM chunks WHERE id = ?
    `)
      .get("chunk1") as { access_count: number; last_accessed_at: number };

    expect(chunk.access_count).toBe(1);
    expect(chunk.last_accessed_at).toBe(now);

    db.close();
  });

  it("increments access count on multiple calls", () => {
    const db = createTestDb();

    insertChunk(db, { id: "chunk1", accessCount: 5 });

    recordChunkAccess(db, ["chunk1"]);
    recordChunkAccess(db, ["chunk1"]);

    const chunk = db
      .prepare(`
      SELECT access_count FROM chunks WHERE id = ?
    `)
      .get("chunk1") as { access_count: number };

    expect(chunk.access_count).toBe(7);

    db.close();
  });

  it("handles multiple chunks at once", () => {
    const db = createTestDb();

    insertChunk(db, { id: "chunk1", accessCount: 0 });
    insertChunk(db, { id: "chunk2", accessCount: 0 });

    recordChunkAccess(db, ["chunk1", "chunk2"]);

    const chunks = db
      .prepare(`
      SELECT id, access_count FROM chunks ORDER BY id
    `)
      .all() as Array<{ id: string; access_count: number }>;

    expect(chunks[0]?.access_count).toBe(1);
    expect(chunks[1]?.access_count).toBe(1);

    db.close();
  });

  it("handles empty chunk list", () => {
    const db = createTestDb();
    expect(() => recordChunkAccess(db, [])).not.toThrow();
    db.close();
  });
});

describe("initializeChunkTimestamps", () => {
  it("sets timestamps for chunks without them", () => {
    const db = createTestDb();
    const now = Date.now();

    // Insert chunk with zero timestamps
    db.prepare(`
      INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
                          created_at, last_accessed_at, access_count, importance, importance_score, pinned, tags, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'normal', 0.5, 0, '[]', ?)
    `).run("chunk1", "test.md", "memory", 1, 10, "hash1", "model", "text", "[]", now);

    const updated = initializeChunkTimestamps(db, now);

    expect(updated).toBe(1);

    const chunk = db
      .prepare(`
      SELECT created_at, last_accessed_at FROM chunks WHERE id = ?
    `)
      .get("chunk1") as { created_at: number; last_accessed_at: number };

    expect(chunk.created_at).toBe(now);
    expect(chunk.last_accessed_at).toBe(now);

    db.close();
  });

  it("does not modify chunks with existing timestamps", () => {
    const db = createTestDb();
    const existingTime = Date.now() - 10000;
    const now = Date.now();

    insertChunk(db, {
      id: "chunk1",
      createdAt: existingTime,
      lastAccessedAt: existingTime,
    });

    const updated = initializeChunkTimestamps(db, now);

    expect(updated).toBe(0);

    const chunk = db
      .prepare(`
      SELECT created_at, last_accessed_at FROM chunks WHERE id = ?
    `)
      .get("chunk1") as { created_at: number; last_accessed_at: number };

    expect(chunk.created_at).toBe(existingTime);

    db.close();
  });
});

describe("pinChunk/unpinChunk", () => {
  it("pins a chunk and sets max importance", () => {
    const db = createTestDb();

    insertChunk(db, { id: "chunk1", importance: "low", importanceScore: 0.2 });

    const result = pinChunk(db, "chunk1");
    expect(result).toBe(true);

    const chunk = db
      .prepare(`
      SELECT pinned, importance, importance_score FROM chunks WHERE id = ?
    `)
      .get("chunk1") as { pinned: number; importance: string; importance_score: number };

    expect(chunk.pinned).toBe(1);
    expect(chunk.importance).toBe("critical");
    expect(chunk.importance_score).toBe(1.0);

    db.close();
  });

  it("unpins a chunk", () => {
    const db = createTestDb();

    insertChunk(db, { id: "chunk1", pinned: true });

    const result = unpinChunk(db, "chunk1");
    expect(result).toBe(true);

    const chunk = db
      .prepare(`
      SELECT pinned FROM chunks WHERE id = ?
    `)
      .get("chunk1") as { pinned: number };

    expect(chunk.pinned).toBe(0);

    db.close();
  });

  it("returns false for non-existent chunk", () => {
    const db = createTestDb();
    expect(pinChunk(db, "nonexistent")).toBe(false);
    db.close();
  });
});

describe("setChunkImportance", () => {
  it("sets explicit importance level", () => {
    const db = createTestDb();

    insertChunk(db, { id: "chunk1", importance: "normal" });

    const result = setChunkImportance(db, "chunk1", "high");
    expect(result).toBe(true);

    const chunk = db
      .prepare(`
      SELECT importance, importance_score FROM chunks WHERE id = ?
    `)
      .get("chunk1") as { importance: string; importance_score: number };

    expect(chunk.importance).toBe("high");
    expect(chunk.importance_score).toBe(0.8);

    db.close();
  });
});

describe("getPruneCandidates", () => {
  it("returns chunks below minimum importance score", () => {
    const db = createTestDb();
    const now = Date.now();

    insertChunk(db, {
      id: "high",
      importanceScore: 0.8,
      createdAt: now - 100 * 24 * 60 * 60 * 1000,
    });
    insertChunk(db, {
      id: "low",
      importanceScore: 0.05,
      createdAt: now - 100 * 24 * 60 * 60 * 1000,
    });

    const policy: RetentionPolicy = {
      ...DEFAULT_RETENTION_POLICY,
      minImportanceScore: 0.1,
      maxAgeDays: 0, // Disable age filter
    };

    const candidates = getPruneCandidates(db, policy, now);

    expect(candidates.length).toBe(1);
    expect(candidates[0]?.id).toBe("low");

    db.close();
  });

  it("returns chunks older than max age", () => {
    const db = createTestDb();
    const now = Date.now();

    insertChunk(db, { id: "recent", createdAt: now, importanceScore: 0.5 });
    insertChunk(db, {
      id: "old",
      createdAt: now - 100 * 24 * 60 * 60 * 1000,
      importanceScore: 0.5,
    });

    const policy: RetentionPolicy = {
      ...DEFAULT_RETENTION_POLICY,
      maxAgeDays: 90,
      minImportanceScore: 0,
    };

    const candidates = getPruneCandidates(db, policy, now);

    expect(candidates.length).toBe(1);
    expect(candidates[0]?.id).toBe("old");

    db.close();
  });

  it("excludes pinned chunks", () => {
    const db = createTestDb();
    const now = Date.now();
    const oldTime = now - 100 * 24 * 60 * 60 * 1000; // 100 days ago

    insertChunk(db, { id: "pinned", pinned: true, importanceScore: 0.05, createdAt: oldTime });
    insertChunk(db, { id: "unpinned", pinned: false, importanceScore: 0.05, createdAt: oldTime });

    const policy: RetentionPolicy = {
      ...DEFAULT_RETENTION_POLICY,
      minImportanceScore: 0.1,
    };

    const candidates = getPruneCandidates(db, policy, now);

    expect(candidates.length).toBe(1);
    expect(candidates[0]?.id).toBe("unpinned");

    db.close();
  });

  it("sorts by importance score ascending", () => {
    const db = createTestDb();
    const now = Date.now();

    insertChunk(db, {
      id: "medium",
      importanceScore: 0.05,
      createdAt: now - 100 * 24 * 60 * 60 * 1000,
    });
    insertChunk(db, {
      id: "lowest",
      importanceScore: 0.01,
      createdAt: now - 100 * 24 * 60 * 60 * 1000,
    });
    insertChunk(db, {
      id: "low",
      importanceScore: 0.03,
      createdAt: now - 100 * 24 * 60 * 60 * 1000,
    });

    const policy: RetentionPolicy = {
      ...DEFAULT_RETENTION_POLICY,
      minImportanceScore: 0.1,
    };

    const candidates = getPruneCandidates(db, policy, now);

    expect(candidates.map((c) => c.id)).toEqual(["lowest", "low", "medium"]);

    db.close();
  });
});

describe("pruneChunks", () => {
  it("does nothing when policy is disabled", () => {
    const db = createTestDb();

    insertChunk(db, { id: "chunk1", importanceScore: 0.01 });

    const policy: RetentionPolicy = {
      ...DEFAULT_RETENTION_POLICY,
      enabled: false,
    };

    const result = pruneChunks(db, policy);

    expect(result.pruned).toBe(0);
    expect(result.archived).toBe(0);

    db.close();
  });

  it("archives chunks when archiveInsteadOfDelete is true", () => {
    const db = createTestDb();
    const now = Date.now();

    insertChunk(db, {
      id: "chunk1",
      importanceScore: 0.05,
      createdAt: now - 100 * 24 * 60 * 60 * 1000,
    });

    const policy: RetentionPolicy = {
      ...DEFAULT_RETENTION_POLICY,
      minImportanceScore: 0.1,
      archiveInsteadOfDelete: true,
    };

    const result = pruneChunks(db, policy, { now });

    expect(result.archived).toBe(1);
    expect(result.pruned).toBe(0);

    const chunk = db
      .prepare(`
      SELECT importance FROM chunks WHERE id = ?
    `)
      .get("chunk1") as { importance: string };

    expect(chunk.importance).toBe("archive");

    db.close();
  });

  it("deletes chunks when archiveInsteadOfDelete is false", () => {
    const db = createTestDb();
    const now = Date.now();

    insertChunk(db, {
      id: "chunk1",
      importanceScore: 0.05,
      createdAt: now - 100 * 24 * 60 * 60 * 1000,
    });

    const policy: RetentionPolicy = {
      ...DEFAULT_RETENTION_POLICY,
      minImportanceScore: 0.1,
      archiveInsteadOfDelete: false,
    };

    const result = pruneChunks(db, policy, { now });

    expect(result.pruned).toBe(1);

    const count = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };
    expect(count.c).toBe(0);

    db.close();
  });

  it("respects maxToPrune limit", () => {
    const db = createTestDb();
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      insertChunk(db, {
        id: `chunk${i}`,
        importanceScore: 0.05,
        createdAt: now - 100 * 24 * 60 * 60 * 1000,
      });
    }

    const policy: RetentionPolicy = {
      ...DEFAULT_RETENTION_POLICY,
      minImportanceScore: 0.1,
      archiveInsteadOfDelete: false,
    };

    const result = pruneChunks(db, policy, { maxToPrune: 2, now });

    expect(result.pruned).toBe(2);

    const count = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };
    expect(count.c).toBe(3);

    db.close();
  });

  it("supports dry run mode", () => {
    const db = createTestDb();
    const now = Date.now();

    insertChunk(db, {
      id: "chunk1",
      importanceScore: 0.05,
      createdAt: now - 100 * 24 * 60 * 60 * 1000,
    });

    const policy: RetentionPolicy = {
      ...DEFAULT_RETENTION_POLICY,
      minImportanceScore: 0.1,
    };

    const result = pruneChunks(db, policy, { dryRun: true, now });

    expect(result.pruned).toBe(1);

    // Chunk should still exist
    const count = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };
    expect(count.c).toBe(1);

    db.close();
  });
});

describe("enforceStorageLimits", () => {
  it("prunes when chunk count exceeds limit", () => {
    const db = createTestDb();

    for (let i = 0; i < 10; i++) {
      insertChunk(db, {
        id: `chunk${i}`,
        importanceScore: i * 0.1, // 0.0 to 0.9
      });
    }

    const policy: RetentionPolicy = {
      ...DEFAULT_RETENTION_POLICY,
      maxChunks: 5,
      minImportanceScore: 0, // Don't filter by importance
      maxAgeDays: 0, // Don't filter by age
      archiveInsteadOfDelete: false,
    };

    const result = enforceStorageLimits(db, policy);

    expect(result.pruned).toBe(5);

    const count = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };
    expect(count.c).toBe(5);

    db.close();
  });

  it("does nothing when under limits", () => {
    const db = createTestDb();

    insertChunk(db, { id: "chunk1" });

    const policy: RetentionPolicy = {
      ...DEFAULT_RETENTION_POLICY,
      maxChunks: 100,
      maxStorageBytes: 100 * 1024 * 1024,
    };

    const result = enforceStorageLimits(db, policy);

    expect(result.pruned).toBe(0);
    expect(result.archived).toBe(0);

    db.close();
  });
});

describe("getRetentionStats", () => {
  it("returns comprehensive statistics", () => {
    const db = createTestDb();
    const now = Date.now();

    insertChunk(db, {
      id: "chunk1",
      source: "memory",
      importance: "high",
      createdAt: now - 10 * 24 * 60 * 60 * 1000,
    });
    insertChunk(db, {
      id: "chunk2",
      source: "sessions",
      importance: "low",
      createdAt: now - 5 * 24 * 60 * 60 * 1000,
    });

    const stats = getRetentionStats(db, DEFAULT_RETENTION_POLICY, now);

    expect(stats.totalChunks).toBe(2);
    expect(stats.bySource.memory).toBe(1);
    expect(stats.bySource.sessions).toBe(1);
    expect(stats.byImportance.high).toBe(1);
    expect(stats.byImportance.low).toBe(1);
    expect(stats.oldestChunkAge).toBeCloseTo(10, 0);

    db.close();
  });

  it("handles empty database", () => {
    const db = createTestDb();

    const stats = getRetentionStats(db, DEFAULT_RETENTION_POLICY);

    expect(stats.totalChunks).toBe(0);
    expect(stats.totalBytes).toBe(0);
    expect(stats.averageImportanceScore).toBe(0.5);

    db.close();
  });
});

describe("updateImportanceScores", () => {
  it("recalculates scores for all chunks", () => {
    const db = createTestDb();
    const now = Date.now();

    insertChunk(db, {
      id: "old",
      createdAt: now - 60 * 24 * 60 * 60 * 1000,
      lastAccessedAt: now - 60 * 24 * 60 * 60 * 1000,
      accessCount: 0,
      importanceScore: 0.5,
    });

    insertChunk(db, {
      id: "new",
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 50,
      importanceScore: 0.5,
    });

    const updated = updateImportanceScores(db, DEFAULT_RETENTION_POLICY, now);

    expect(updated).toBe(2);

    const oldChunk = db
      .prepare(`
      SELECT importance_score FROM chunks WHERE id = ?
    `)
      .get("old") as { importance_score: number };

    const newChunk = db
      .prepare(`
      SELECT importance_score FROM chunks WHERE id = ?
    `)
      .get("new") as { importance_score: number };

    expect(newChunk.importance_score).toBeGreaterThan(oldChunk.importance_score);

    db.close();
  });
});
