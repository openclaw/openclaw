import type { Collection, Db, Document } from "mongodb";
import fs from "node:fs/promises";
import type { MemoryMongoDBEmbeddingMode } from "../config/types.memory.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { MemorySyncProgressUpdate, MemorySource } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildFileEntry,
  chunkMarkdown,
  listMemoryFiles,
  type MemoryChunk,
  type MemoryFileEntry,
} from "./internal.js";
import { chunksCollection, filesCollection } from "./mongodb-schema.js";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  type SessionFileEntry,
} from "./session-files.js";

const log = createSubsystemLogger("memory:mongodb:sync");

// Re-export chunk helpers from internal.ts
export { chunkMarkdown };

// ---------------------------------------------------------------------------
// File metadata operations
// ---------------------------------------------------------------------------

async function getStoredFiles(
  files: Collection,
): Promise<Map<string, { hash: string; mtime: number; size: number }>> {
  const docs = await files.find({}).toArray();
  const map = new Map<string, { hash: string; mtime: number; size: number }>();
  for (const doc of docs) {
    map.set(String(doc._id), {
      hash: doc.hash as string,
      mtime: doc.mtime as number,
      size: doc.size as number,
    });
  }
  return map;
}

async function upsertFileMetadata(
  files: Collection,
  entry: MemoryFileEntry,
  source: MemorySource,
): Promise<void> {
  await files.updateOne(
    { _id: entry.path as unknown as Document["_id"] },
    {
      $set: {
        source,
        hash: entry.hash,
        mtime: entry.mtimeMs,
        size: entry.size,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

// ---------------------------------------------------------------------------
// Chunk operations
// ---------------------------------------------------------------------------

function buildChunkId(path: string, startLine: number, endLine: number): string {
  return `${path}:${startLine}:${endLine}`;
}

async function upsertChunks(
  chunks: Collection,
  path: string,
  source: MemorySource,
  chunkList: MemoryChunk[],
  model: string,
  embeddings: number[][] | null,
): Promise<number> {
  if (chunkList.length === 0) {
    return 0;
  }

  const ops = chunkList.map((chunk, index) => {
    const chunkId = buildChunkId(path, chunk.startLine, chunk.endLine);
    const setDoc: Document = {
      path,
      source,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      hash: chunk.hash,
      model,
      text: chunk.text,
      updatedAt: new Date(),
    };
    // Only include embedding if we have one (managed mode)
    if (embeddings && embeddings[index]) {
      setDoc.embedding = embeddings[index];
    }
    return {
      updateOne: {
        filter: { _id: chunkId as unknown as Document["_id"] },
        update: { $set: setDoc },
        upsert: true,
      },
    };
  });

  const result = await chunks.bulkWrite(ops, { ordered: false });
  return result.upsertedCount + result.modifiedCount;
}

async function deleteChunksForPath(chunks: Collection, path: string): Promise<number> {
  const result = await chunks.deleteMany({ path });
  return result.deletedCount;
}

async function deleteStaleChunks(chunks: Collection, validPaths: Set<string>): Promise<number> {
  const allPaths = await chunks.distinct("path");
  const stalePaths = allPaths.filter((p) => !validPaths.has(p));
  if (stalePaths.length === 0) {
    return 0;
  }

  const result = await chunks.deleteMany({ path: { $in: stalePaths } });
  return result.deletedCount;
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

export type SyncResult = {
  filesProcessed: number;
  chunksUpserted: number;
  staleDeleted: number;
  sessionFilesProcessed: number;
  sessionChunksUpserted: number;
};

export async function syncToMongoDB(params: {
  db: Db;
  prefix: string;
  agentId?: string;
  workspaceDir: string;
  extraPaths?: string[];
  embeddingMode: MemoryMongoDBEmbeddingMode;
  embeddingProvider?: EmbeddingProvider;
  chunking?: { tokens: number; overlap: number };
  model?: string;
  reason?: string;
  force?: boolean;
  progress?: (update: MemorySyncProgressUpdate) => void;
}): Promise<SyncResult> {
  const { db, prefix, workspaceDir, extraPaths, embeddingMode, progress } = params;
  const model = params.model ?? "voyage-4-large";
  const chunking = params.chunking ?? { tokens: 400, overlap: 80 };

  const chunksCol = chunksCollection(db, prefix);
  const filesCol = filesCollection(db, prefix);

  // 2. Get stored file metadata from MongoDB
  const storedFiles = await getStoredFiles(filesCol);

  // =========================================================================
  // Phase A: Memory files (source="memory")
  // =========================================================================

  // 1. List memory files on disk (returns absolute paths)
  const diskPaths = await listMemoryFiles(workspaceDir, extraPaths);
  log.info(
    `sync: found ${diskPaths.length} memory files on disk (reason=${params.reason ?? "manual"})`,
  );

  // Build file entries with hash, mtime, size
  const diskFiles: MemoryFileEntry[] = [];
  for (const absPath of diskPaths) {
    try {
      diskFiles.push(await buildFileEntry(absPath, workspaceDir));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`sync: failed to read ${absPath}: ${msg}`);
    }
  }

  // Determine which files need re-indexing
  const filesToProcess: MemoryFileEntry[] = [];
  const validPaths = new Set<string>();

  for (const file of diskFiles) {
    validPaths.add(file.path);
    const stored = storedFiles.get(file.path);
    if (params.force || !stored || stored.hash !== file.hash) {
      filesToProcess.push(file);
    }
  }

  log.info(`sync: ${filesToProcess.length}/${diskPaths.length} memory files need re-indexing`);
  progress?.({ completed: 0, total: filesToProcess.length, label: "Syncing memory files" });

  // Process each changed memory file
  let filesProcessed = 0;
  let totalChunksUpserted = 0;

  for (const file of filesToProcess) {
    try {
      const content = await fs.readFile(file.absPath, "utf-8");
      const chunks = chunkMarkdown(content, chunking);

      let embeddings: number[][] | null = null;
      if (embeddingMode === "managed" && params.embeddingProvider) {
        try {
          const texts = chunks.map((c: MemoryChunk) => c.text);
          embeddings = await params.embeddingProvider.embedBatch(texts);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`embedding generation failed for ${file.path}: ${msg}`);
        }
      }

      await deleteChunksForPath(chunksCol, file.path);
      const upserted = await upsertChunks(
        chunksCol,
        file.path,
        "memory",
        chunks,
        model,
        embeddings,
      );
      totalChunksUpserted += upserted;
      await upsertFileMetadata(filesCol, file, "memory");

      filesProcessed++;
      progress?.({ completed: filesProcessed, total: filesToProcess.length, label: file.path });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`sync failed for ${file.path}: ${msg}`);
    }
  }

  // =========================================================================
  // Phase B: Session transcript files (source="sessions")
  // =========================================================================

  let sessionFilesProcessed = 0;
  let sessionChunksUpserted = 0;

  if (params.agentId) {
    try {
      const sessionResult = await syncSessionFiles({
        agentId: params.agentId,
        chunksCol,
        filesCol,
        storedFiles,
        validPaths,
        embeddingMode,
        embeddingProvider: params.embeddingProvider,
        chunking,
        model,
        force: params.force,
        progress,
      });
      sessionFilesProcessed = sessionResult.filesProcessed;
      sessionChunksUpserted = sessionResult.chunksUpserted;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`session sync failed: ${msg}`);
    }
  }

  // =========================================================================
  // Phase C: Stale cleanup (covers both memory and session paths)
  // =========================================================================

  const staleDeleted = await deleteStaleChunks(chunksCol, validPaths);
  if (staleDeleted > 0) {
    log.info(`sync: removed ${staleDeleted} stale chunks`);
  }

  // Clean up stale file entries
  for (const [storedPath] of storedFiles) {
    if (!validPaths.has(storedPath)) {
      await filesCol.deleteOne({ _id: storedPath as unknown as Document["_id"] });
    }
  }

  log.info(
    `sync complete: memory=${filesProcessed}/${diskPaths.length} sessions=${sessionFilesProcessed} chunks=${totalChunksUpserted + sessionChunksUpserted} stale=${staleDeleted}`,
  );

  return {
    filesProcessed,
    chunksUpserted: totalChunksUpserted,
    staleDeleted,
    sessionFilesProcessed,
    sessionChunksUpserted,
  };
}

// ---------------------------------------------------------------------------
// Session file sync
// ---------------------------------------------------------------------------

async function syncSessionFiles(params: {
  agentId: string;
  chunksCol: Collection;
  filesCol: Collection;
  storedFiles: Map<string, { hash: string; mtime: number; size: number }>;
  validPaths: Set<string>;
  embeddingMode: MemoryMongoDBEmbeddingMode;
  embeddingProvider?: EmbeddingProvider;
  chunking: { tokens: number; overlap: number };
  model: string;
  force?: boolean;
  progress?: (update: MemorySyncProgressUpdate) => void;
}): Promise<{ filesProcessed: number; chunksUpserted: number }> {
  const sessionPaths = await listSessionFilesForAgent(params.agentId);
  if (sessionPaths.length === 0) {
    return { filesProcessed: 0, chunksUpserted: 0 };
  }

  log.info(`sync: found ${sessionPaths.length} session files`);
  let filesProcessed = 0;
  let chunksUpserted = 0;

  for (const absPath of sessionPaths) {
    try {
      const entry = await buildSessionEntry(absPath);
      if (!entry || !entry.content) {
        continue;
      }

      // Track this session path as valid (for stale cleanup)
      params.validPaths.add(entry.path);

      // Check if already indexed with same hash
      const stored = params.storedFiles.get(entry.path);
      if (!params.force && stored?.hash === entry.hash) {
        continue;
      }

      // Chunk the session content (same as memory files)
      const chunks = chunkMarkdown(entry.content, params.chunking);

      // Generate embeddings in managed mode
      let embeddings: number[][] | null = null;
      if (params.embeddingMode === "managed" && params.embeddingProvider) {
        try {
          const texts = chunks.map((c: MemoryChunk) => c.text);
          embeddings = await params.embeddingProvider.embedBatch(texts);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`session embedding failed for ${entry.path}: ${msg}`);
        }
      }

      // Delete old chunks, upsert new ones with source="sessions"
      await deleteChunksForPath(params.chunksCol, entry.path);
      const upserted = await upsertChunks(
        params.chunksCol,
        entry.path,
        "sessions",
        chunks,
        params.model,
        embeddings,
      );
      chunksUpserted += upserted;

      // Store session file metadata
      await upsertSessionFileMetadata(params.filesCol, entry);
      filesProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`session sync failed for ${absPath}: ${msg}`);
    }
  }

  log.info(`sync: sessions processed=${filesProcessed} chunks=${chunksUpserted}`);
  return { filesProcessed, chunksUpserted };
}

async function upsertSessionFileMetadata(
  files: Collection,
  entry: SessionFileEntry,
): Promise<void> {
  await files.updateOne(
    { _id: entry.path as unknown as Document["_id"] },
    {
      $set: {
        source: "sessions" as MemorySource,
        hash: entry.hash,
        mtime: entry.mtimeMs,
        size: entry.size,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}
