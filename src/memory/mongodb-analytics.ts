import type { Db, Document } from "mongodb";
import type { EmbeddingStatusCoverage } from "./mongodb-embedding-retry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  chunksCollection,
  filesCollection,
  embeddingCacheCollection,
  kbChunksCollection,
  structuredMemCollection,
} from "./mongodb-schema.js";

const log = createSubsystemLogger("memory:mongodb:analytics");

export type MemorySourceStats = {
  source: string;
  fileCount: number;
  chunkCount: number;
  lastSync: Date | null;
};

export type EmbeddingCoverage = {
  withEmbedding: number;
  withoutEmbedding: number;
  total: number;
  coveragePercent: number;
};

export type IndexStatsEntry = {
  collection: string;
  name: string;
  accesses: number;
  since: Date | null;
};

export type MemoryStats = {
  sources: MemorySourceStats[];
  totalFiles: number;
  totalChunks: number;
  embeddingCoverage: EmbeddingCoverage;
  embeddingStatusCoverage: EmbeddingStatusCoverage;
  cachedEmbeddings: number;
  staleFiles: string[];
  collectionSizes: {
    files: number;
    chunks: number;
    embeddingCache: number;
  };
  indexStats: IndexStatsEntry[];
};

export async function getMemoryStats(
  db: Db,
  prefix: string,
  validPaths?: Set<string>,
): Promise<MemoryStats> {
  const chunksCol = chunksCollection(db, prefix);
  const filesCol = filesCollection(db, prefix);
  const cacheCol = embeddingCacheCollection(db, prefix);

  // Per-source file breakdown
  const sourceAgg: Document[] = await filesCol
    .aggregate([
      {
        $group: {
          _id: "$source",
          count: { $sum: 1 },
          lastSync: { $max: "$updatedAt" },
        },
      },
    ])
    .toArray();

  const sources: MemorySourceStats[] = sourceAgg.map((doc) => ({
    source: String(doc._id ?? "unknown"),
    fileCount: doc.count as number,
    chunkCount: 0, // filled below
    lastSync: doc.lastSync instanceof Date ? doc.lastSync : null,
  }));

  // Per-source chunk counts
  const chunkSourceAgg: Document[] = await chunksCol
    .aggregate([{ $group: { _id: "$source", count: { $sum: 1 } } }])
    .toArray();

  for (const doc of chunkSourceAgg) {
    const src = sources.find((s) => s.source === String(doc._id));
    if (src) {
      src.chunkCount = doc.count as number;
    }
  }

  // Embedding coverage
  const embeddingAgg: Document[] = await chunksCol
    .aggregate([
      {
        $group: {
          _id: null,
          withEmbedding: {
            $sum: {
              $cond: [{ $gt: [{ $size: { $ifNull: ["$embedding", []] } }, 0] }, 1, 0],
            },
          },
          total: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const embRow = embeddingAgg[0] ?? { withEmbedding: 0, total: 0 };
  const withEmb = embRow.withEmbedding as number;
  const totalChunks = embRow.total as number;
  const embeddingCoverage: EmbeddingCoverage = {
    withEmbedding: withEmb,
    withoutEmbedding: totalChunks - withEmb,
    total: totalChunks,
    coveragePercent: totalChunks > 0 ? Math.round((withEmb / totalChunks) * 100) : 0,
  };

  // Embedding status coverage (across chunks, kb_chunks, and structured_mem)
  const embeddingStatusCoverage = await aggregateEmbeddingStatusCoverage(db, prefix);

  // Cached embeddings count
  const cachedEmbeddings = await cacheCol.countDocuments();

  // Stale files (in DB but not on disk)
  let staleFiles: string[] = [];
  if (validPaths) {
    const allDbPaths = await filesCol.distinct("_id");
    staleFiles = allDbPaths.map(String).filter((p) => !validPaths.has(p));
  }

  // $indexStats: show which indexes are used and which are unused
  const indexStats = await aggregateIndexStats(db, prefix);

  // Collection document counts
  const totalFiles = await filesCol.countDocuments();

  log.info(
    `stats: files=${totalFiles} chunks=${totalChunks} cached=${cachedEmbeddings} ` +
      `embeddingStatus={success=${embeddingStatusCoverage.success},failed=${embeddingStatusCoverage.failed},pending=${embeddingStatusCoverage.pending}} ` +
      `stale=${staleFiles.length}`,
  );

  return {
    sources,
    totalFiles,
    totalChunks,
    embeddingCoverage,
    embeddingStatusCoverage,
    cachedEmbeddings,
    staleFiles,
    collectionSizes: {
      files: totalFiles,
      chunks: totalChunks,
      embeddingCache: cachedEmbeddings,
    },
    indexStats,
  };
}

/**
 * Aggregate embeddingStatus across all chunk collections (chunks, kb_chunks, structured_mem).
 * Returns counts of success/failed/pending documents.
 */
async function aggregateEmbeddingStatusCoverage(
  db: Db,
  prefix: string,
): Promise<EmbeddingStatusCoverage> {
  const collections = [
    chunksCollection(db, prefix),
    kbChunksCollection(db, prefix),
    structuredMemCollection(db, prefix),
  ];

  let total = 0;
  let success = 0;
  let failed = 0;
  let pending = 0;

  for (const col of collections) {
    try {
      const statusAgg: Document[] = await col
        .aggregate([
          {
            $group: {
              _id: { $ifNull: ["$embeddingStatus", "pending"] },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray();

      for (const doc of statusAgg) {
        const status = String(doc._id);
        const count = doc.count as number;
        total += count;
        if (status === "success") {
          success += count;
        } else if (status === "failed") {
          failed += count;
        } else {
          pending += count;
        }
      }
    } catch {
      // Collection may not exist yet — ignore
    }
  }

  return { total, success, failed, pending };
}

/**
 * Aggregate $indexStats across key collections (chunks, kb_chunks, structured_mem).
 * Returns per-index access counts so users can identify unused indexes.
 * Fails gracefully if $indexStats is not supported (e.g., some MongoDB versions).
 */
async function aggregateIndexStats(db: Db, prefix: string): Promise<IndexStatsEntry[]> {
  const collectionsToCheck: Array<{ col: ReturnType<typeof chunksCollection>; label: string }> = [
    { col: chunksCollection(db, prefix), label: `${prefix}chunks` },
    { col: kbChunksCollection(db, prefix), label: `${prefix}kb_chunks` },
    { col: structuredMemCollection(db, prefix), label: `${prefix}structured_mem` },
  ];

  const results: IndexStatsEntry[] = [];

  for (const { col, label } of collectionsToCheck) {
    try {
      const stats: Document[] = await col.aggregate([{ $indexStats: {} }]).toArray();
      for (const stat of stats) {
        results.push({
          collection: label,
          name: String(stat.name ?? "unknown"),
          accesses: typeof stat.accesses?.ops === "number" ? stat.accesses.ops : 0,
          since: stat.accesses?.since instanceof Date ? stat.accesses.since : null,
        });
      }
    } catch {
      // $indexStats may not be supported — skip this collection
    }
  }

  return results;
}
