import type { Db, MongoClient, ClientSession } from "mongodb";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryMongoDBEmbeddingMode } from "../config/types.memory.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { chunkMarkdown, hashText } from "./internal.js";
import { retryEmbedding, type EmbeddingStatus } from "./mongodb-embedding-retry.js";
import { kbCollection, kbChunksCollection } from "./mongodb-schema.js";

const log = createSubsystemLogger("memory:mongodb:kb");

// ---------------------------------------------------------------------------
// Transaction helpers (same pattern as mongodb-sync.ts)
// ---------------------------------------------------------------------------

function isTransactionNotSupported(err: unknown): boolean {
  if (err instanceof Error && "code" in err) {
    const code = (err as { code: number }).code;
    // 20 = IllegalOperation (standalone), 263 = NoSuchTransaction
    if (code === 20 || code === 263) {
      return true;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("Transaction numbers are only allowed on a replica set");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KBDocument = {
  title: string;
  content: string;
  source: {
    type: "file" | "url" | "manual" | "api";
    path?: string;
    url?: string;
    mimeType?: string;
    originalName?: string;
    importedBy: "wizard" | "cli" | "api" | "agent";
  };
  tags?: string[];
  category?: string;
  hash: string;
};

export type KBIngestResult = {
  documentsProcessed: number;
  chunksCreated: number;
  skipped: number;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export async function ingestToKB(params: {
  db: Db;
  prefix: string;
  documents: KBDocument[];
  embeddingMode: MemoryMongoDBEmbeddingMode;
  embeddingProvider?: EmbeddingProvider;
  chunking?: { tokens: number; overlap: number };
  model?: string;
  force?: boolean;
  maxDocumentSize?: number;
  client?: MongoClient;
  progress?: (update: { completed: number; total: number; label: string }) => void;
}): Promise<KBIngestResult> {
  const { db, prefix, documents, embeddingMode, force, progress } = params;
  const maxDocSize = params.maxDocumentSize ?? 10 * 1024 * 1024; // default 10MB
  const chunking = params.chunking ?? { tokens: 600, overlap: 100 };
  const model = params.model ?? "voyage-4-large";
  const kb = kbCollection(db, prefix);
  const kbChunks = kbChunksCollection(db, prefix);

  const result: KBIngestResult = {
    documentsProcessed: 0,
    chunksCreated: 0,
    skipped: 0,
    errors: [],
  };

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    progress?.({ completed: i, total: documents.length, label: doc.title });

    try {
      // Size enforcement — reject documents that exceed maxDocumentSize
      if (doc.content.length > maxDocSize) {
        result.errors.push(
          `${doc.title}: document too large (${doc.content.length} bytes > ${maxDocSize} limit)`,
        );
        result.skipped++;
        continue;
      }

      // F10: Dedup check by source.path first, then content hash.
      // If a document with the same path exists, replace it only if hash changed.
      // These dedup lookups are OUTSIDE the transaction body (read-only I/O).
      let reIngestionOldId: string | null = null;
      let reIngestionOldDocId: unknown = null;
      if (!force) {
        const sourcePath = doc.source.path ?? doc.title;
        const existingByPath = await kb.findOne({ "source.path": sourcePath });
        if (existingByPath) {
          if (existingByPath.hash === doc.hash) {
            // Same content — skip
            result.skipped++;
            continue;
          }
          // Hash changed — mark for re-ingestion (delete old + insert new)
          reIngestionOldId = String(existingByPath._id);
          reIngestionOldDocId = existingByPath._id;
        } else {
          // No path match — check hash as fallback
          const existingByHash = await kb.findOne({ hash: doc.hash });
          if (existingByHash) {
            result.skipped++;
            continue;
          }
        }
      }

      // Chunk the document content — OUTSIDE transaction body (CPU-bound)
      const chunks = chunkMarkdown(doc.content, chunking);

      // Generate embeddings if managed mode — with retry + exponential backoff
      // OUTSIDE transaction body (network I/O, keeps txn short per ops-transaction-runtime-limit)
      let embeddings: number[][] | null = null;
      let embeddingStatus: EmbeddingStatus = "pending";
      if (embeddingMode === "managed" && params.embeddingProvider) {
        const provider = params.embeddingProvider;
        try {
          const texts = chunks.map((c) => c.text);
          embeddings = await retryEmbedding((t) => provider.embedBatch(t), texts);
          embeddingStatus = "success";
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(
            `embedding generation failed for ${doc.title} after retries: ${msg}. ` +
              'Storing chunks with embeddingStatus: "failed".',
          );
          embeddingStatus = "failed";
        }
      }

      // Generate a document ID
      const docId = crypto.randomUUID();

      // Prepare force-mode dedup lookup OUTSIDE transaction
      let forceOldId: string | null = null;
      let forceOldDocId: unknown = null;
      if (force) {
        const existingDoc = await kb.findOne({ hash: doc.hash });
        if (existingDoc) {
          forceOldId = String(existingDoc._id);
          forceOldDocId = existingDoc._id;
        }
      }

      // Build the chunk operation list (data prep, not DB I/O)
      const chunkOps = chunks.map((chunk, idx) => {
        const chunkDoc: Record<string, unknown> = {
          docId,
          path: doc.source.path ?? doc.title,
          source: "kb",
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          hash: chunk.hash,
          model,
          text: chunk.text,
          embeddingStatus,
          updatedAt: new Date(),
        };
        if (embeddings && embeddings[idx]) {
          chunkDoc.embedding = embeddings[idx];
        }
        return {
          updateOne: {
            filter: {
              path: doc.source.path ?? doc.title,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
            },
            update: { $set: chunkDoc },
            upsert: true,
          },
        };
      });

      // The new KB document to insert
      const newKBDoc = {
        _id: docId as unknown as any,
        title: doc.title,
        content: doc.content,
        source: {
          ...doc.source,
          importedAt: new Date(),
        },
        tags: doc.tags ?? [],
        category: doc.category ?? undefined,
        hash: doc.hash,
        chunkCount: chunks.length,
        updatedAt: new Date(),
      };

      // Determine whether we need a transaction (re-ingestion involves delete + insert)
      const needsTransaction = reIngestionOldId !== null || forceOldId !== null;
      const oldIdToDelete = reIngestionOldId ?? forceOldId;
      const oldDocIdToDelete = reIngestionOldDocId ?? forceOldDocId;

      if (needsTransaction) {
        // Re-ingestion path: wrap delete-old + insert-new in withTransaction()
        // for atomicity. Falls back to sequential on standalone topology.
        const chunksCreated = await reIngestAtomically({
          client: params.client,
          kb,
          kbChunks,
          oldDocId: oldIdToDelete!,
          oldDocPk: oldDocIdToDelete,
          newKBDoc,
          chunkOps,
        });
        result.chunksCreated += chunksCreated;
      } else {
        // Fresh ingestion: no delete needed, no transaction required
        await kb.insertOne(newKBDoc);
        if (chunkOps.length > 0) {
          const writeResult = await kbChunks.bulkWrite(chunkOps, { ordered: false });
          result.chunksCreated += writeResult.upsertedCount + writeResult.modifiedCount;
        }
      }

      result.documentsProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${doc.title}: ${msg}`);
      log.warn(`KB ingest failed for ${doc.title}: ${msg}`);
    }
  }

  progress?.({ completed: documents.length, total: documents.length, label: "Done" });
  log.info(
    `KB ingest: processed=${result.documentsProcessed} chunks=${result.chunksCreated} skipped=${result.skipped} errors=${result.errors.length}`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Atomic re-ingestion helper (withTransaction + standalone fallback)
// ---------------------------------------------------------------------------

/**
 * Atomically re-ingest a KB document: delete old chunks + doc, insert new doc + chunks.
 * Uses withTransaction() when client is provided. Falls back to sequential writes
 * on standalone topology (same pattern as mongodb-sync.ts).
 * Returns the number of chunks created.
 */
async function reIngestAtomically(params: {
  client?: MongoClient;
  kb: import("mongodb").Collection;
  kbChunks: import("mongodb").Collection;
  oldDocId: string;
  oldDocPk: unknown;
  newKBDoc: Record<string, unknown>;
  chunkOps: Array<{
    updateOne: {
      filter: Record<string, unknown>;
      update: Record<string, unknown>;
      upsert: boolean;
    };
  }>;
}): Promise<number> {
  const { client, kb, kbChunks, oldDocId, oldDocPk, newKBDoc, chunkOps } = params;

  // Inner write function — performs all DB writes, optionally with a session.
  // Per `fundamental-propagate-session`: pass session to EVERY operation inside the transaction.
  // When no session, call without the options arg to match test expectations.
  async function performWrites(session?: ClientSession): Promise<number> {
    if (session) {
      await kbChunks.deleteMany({ docId: oldDocId }, { session });
      await kb.deleteOne({ _id: oldDocPk } as Record<string, unknown>, { session });
      await kb.insertOne(newKBDoc, { session });
    } else {
      await kbChunks.deleteMany({ docId: oldDocId });
      await kb.deleteOne({ _id: oldDocPk } as Record<string, unknown>);
      await kb.insertOne(newKBDoc);
    }

    // Insert new chunks
    let chunksCreated = 0;
    if (chunkOps.length > 0) {
      const writeResult = session
        ? await kbChunks.bulkWrite(chunkOps, { ordered: false, session })
        : await kbChunks.bulkWrite(chunkOps, { ordered: false });
      chunksCreated = writeResult.upsertedCount + writeResult.modifiedCount;
    }
    return chunksCreated;
  }

  // Try transactional path if client is available
  if (client) {
    try {
      const session = client.startSession();
      try {
        let chunksCreated = 0;
        await session.withTransaction(
          async () => {
            chunksCreated = await performWrites(session);
          },
          { writeConcern: { w: "majority" } },
        );
        return chunksCreated;
      } finally {
        await session.endSession();
      }
    } catch (err) {
      // Standalone or no replica set — fall through to sequential
      if (isTransactionNotSupported(err)) {
        log.info("transactions not supported for KB re-ingestion, falling back to direct writes");
      } else {
        log.warn(
          `transaction failed for KB re-ingestion, falling back to sequential: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Sequential fallback (no transaction)
  return performWrites();
}

// ---------------------------------------------------------------------------
// File ingestion
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set([".md", ".txt"]);

async function walkDirForKB(dir: string, files: string[], recursive: boolean): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory() && recursive) {
      await walkDirForKB(full, files, recursive);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (SUPPORTED_EXTENSIONS.has(ext)) {
      files.push(full);
    }
  }
}

export async function ingestFilesToKB(params: {
  db: Db;
  prefix: string;
  paths: string[];
  recursive?: boolean;
  tags?: string[];
  category?: string;
  importedBy: "wizard" | "cli" | "api" | "agent";
  embeddingMode: MemoryMongoDBEmbeddingMode;
  embeddingProvider?: EmbeddingProvider;
  chunking?: { tokens: number; overlap: number };
  model?: string;
  force?: boolean;
  progress?: (update: { completed: number; total: number; label: string }) => void;
}): Promise<KBIngestResult> {
  const { paths, recursive = true, tags, category, importedBy } = params;

  // Collect all files
  const filePaths: string[] = [];
  for (const inputPath of paths) {
    try {
      const stat = await fs.lstat(inputPath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        await walkDirForKB(inputPath, filePaths, recursive);
      } else if (stat.isFile()) {
        const ext = path.extname(inputPath).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          filePaths.push(inputPath);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`KB file scan failed for ${inputPath}: ${msg}`);
    }
  }

  // Build KBDocument objects from files
  const documents: KBDocument[] = [];
  for (const filePath of filePaths) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = ext === ".md" ? "text/markdown" : "text/plain";
      documents.push({
        title: path.basename(filePath),
        content,
        source: {
          type: "file",
          path: filePath,
          mimeType,
          originalName: path.basename(filePath),
          importedBy,
        },
        tags,
        category,
        hash: hashText(content),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`KB file read failed for ${filePath}: ${msg}`);
    }
  }

  return ingestToKB({
    ...params,
    documents,
  });
}

// ---------------------------------------------------------------------------
// Management functions
// ---------------------------------------------------------------------------

export async function listKBDocuments(
  db: Db,
  prefix: string,
  filter?: { category?: string; tags?: string[]; source?: string },
): Promise<
  Array<{
    _id: string;
    title: string;
    source: Record<string, unknown>;
    tags: string[];
    category?: string;
    chunkCount: number;
    updatedAt: Date;
  }>
> {
  const kb = kbCollection(db, prefix);
  const query: Record<string, unknown> = {};
  if (filter?.category) {
    query.category = filter.category;
  }
  if (filter?.tags?.length) {
    query.tags = { $all: filter.tags };
  }
  if (filter?.source) {
    query["source.type"] = filter.source;
  }

  const docs = await kb.find(query, { sort: { updatedAt: -1 } }).toArray();
  return docs.map((doc: Record<string, unknown>) => ({
    _id: String(doc._id),
    title: doc.title as string,
    source: doc.source as Record<string, unknown>,
    tags: (doc.tags as string[]) ?? [],
    category: doc.category as string | undefined,
    chunkCount: (doc.chunkCount as number) ?? 0,
    updatedAt: doc.updatedAt as Date,
  }));
}

/**
 * F11: Remove a KB document and its chunks, wrapped in a transaction when possible.
 * Uses withTransaction for automatic retry of TransientTransactionError.
 * Falls back to sequential writes on standalone topologies (no replica set).
 */
export async function removeKBDocument(
  db: Db,
  prefix: string,
  docId: string,
  client?: MongoClient,
): Promise<boolean> {
  const kb = kbCollection(db, prefix);
  const kbChunks = kbChunksCollection(db, prefix);

  // Try transaction-wrapped removal (requires replica set)
  if (client) {
    try {
      const session = client.startSession();
      let deleted = false;
      try {
        await session.withTransaction(async () => {
          await kbChunks.deleteMany({ docId }, { session });
          const result = await kb.deleteOne({ _id: docId } as Record<string, unknown>, { session });
          deleted = result.deletedCount > 0;
        });
        return deleted;
      } finally {
        await session.endSession();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Standalone or no replica set — fall through to sequential
      log.warn(`transaction failed for removeKBDocument, falling back to sequential: ${msg}`);
    }
  }

  // Standalone fallback: sequential writes without transaction
  await kbChunks.deleteMany({ docId });
  const result = await kb.deleteOne({ _id: docId } as Record<string, unknown>);
  return result.deletedCount > 0;
}

export async function getKBStats(
  db: Db,
  prefix: string,
): Promise<{
  documents: number;
  chunks: number;
  categories: string[];
  sources: Record<string, number>;
}> {
  const kb = kbCollection(db, prefix);
  const kbChunks = kbChunksCollection(db, prefix);

  const documents = await kb.countDocuments();
  const chunks = await kbChunks.countDocuments();

  // Get distinct categories
  const categories = (await kb.distinct("category")).filter(
    (c): c is string => typeof c === "string",
  );

  // Get source type counts
  const sourcePipeline = [{ $group: { _id: "$source.type", count: { $sum: 1 } } }];
  const sourceResults = await kb.aggregate(sourcePipeline).toArray();
  const sources: Record<string, number> = {};
  for (const s of sourceResults) {
    sources[String(s._id)] = s.count as number;
  }

  return { documents, chunks, categories, sources };
}
