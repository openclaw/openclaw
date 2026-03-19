/**
 * Spreading Activation for Associative Memory Retrieval
 *
 * Inspired by the brain's associative network model:
 * - When one concept is activated, activation spreads to related concepts
 * - Related concepts are connected via edges with different strengths
 * - The spreading continues until energy dissipates or max depth is reached
 *
 * This enables "举一反三" (one example leads to three) capability:
 * - Search for A → find related B, C through associations
 * - Cross-domain connections enable creative insights
 */

import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity, parseEmbedding } from "./internal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("spreading-activation");

export interface SpreadingActivationConfig {
  /** Maximum depth for spreading */
  maxDepth: number;
  /** Minimum activation threshold to include in results */
  activationThreshold: number;
  /** Maximum results to return */
  maxResults: number;
  /** Decay factor per depth level */
  depthDecayFactor: number;
  /** Initial activation from query embedding match */
  queryActivationBoost: number;
}

export const DEFAULT_SPREADING_CONFIG: SpreadingActivationConfig = {
  maxDepth: 2,
  activationThreshold: 0.1,
  maxResults: 20,
  depthDecayFactor: 0.7,
  queryActivationBoost: 1.0,
};

export interface ActivationResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  activation: number;
  depth: number;
  source: string;
  snippet: string;
  schemaType?: string;
}

/**
 * Execute spreading activation search on the associative graph.
 *
 * Algorithm:
 * 1. Find initial activated nodes from query embedding match
 * 2. Spread activation along edges (associations) to neighbors
 * 3. Accumulate activation: total = initial + spread * edge_strength
 * 4. Repeat until maxDepth or threshold
 * 5. Return sorted by activation
 */
export function spreadingActivationSearch(
  db: DatabaseSync,
  queryEmbedding: number[],
  config: Partial<SpreadingActivationConfig> = {},
): ActivationResult[] {
  const cfg: SpreadingActivationConfig = { ...DEFAULT_SPREADING_CONFIG, ...config };

  // Step 1: Find initial activated nodes via embedding similarity
  const initialActivations = findInitialActivatedNodes(db, queryEmbedding, cfg);

  if (initialActivations.length === 0) {
    return [];
  }

  // Step 2: Spread activation through the graph
  const allActivations = new Map<string, ActivationResult>();

  // Initialize with initial activations
  for (const act of initialActivations) {
    allActivations.set(act.id, act);
  }

  // Spread activation up to maxDepth
  for (let depth = 1; depth <= cfg.maxDepth; depth++) {
    const currentLevel = Array.from(allActivations.values()).filter((a) => a.depth === depth - 1);
    if (currentLevel.length === 0) break;

    const nextLevelActivations = new Map<string, ActivationResult>();

    for (const current of currentLevel) {
      // Find neighbors through associations
      const neighbors = findNeighborChunks(db, current.id, cfg);

      for (const neighbor of neighbors) {
        // Calculate spread activation
        // activation = current_activation * edge_strength * depth_decay
        const spreadActivation = current.activation * neighbor.edgeStrength * cfg.depthDecayFactor;

        if (spreadActivation < cfg.activationThreshold) continue;

        const existing = allActivations.get(neighbor.chunkId);
        if (!existing) {
          // New node - add to next level
          nextLevelActivations.set(neighbor.chunkId, {
            id: neighbor.chunkId,
            path: neighbor.path,
            startLine: neighbor.startLine,
            endLine: neighbor.endLine,
            activation: spreadActivation,
            depth,
            source: neighbor.source,
            snippet: neighbor.snippet,
            schemaType: neighbor.schemaType,
          });
        } else {
          // Already visited - accumulate activation (cap at 1.0)
          existing.activation = Math.min(1.0, existing.activation + spreadActivation * 0.5);
        }
      }
    }

    // Add next level to all activations
    for (const [id, act] of nextLevelActivations) {
      allActivations.set(id, act);
    }
  }

  // Sort by activation and return top results
  return Array.from(allActivations.values())
    .toSorted((a, b) => b.activation - a.activation)
    .slice(0, cfg.maxResults);
}

/**
 * Find initially activated nodes via embedding similarity to query.
 */
function findInitialActivatedNodes(
  db: DatabaseSync,
  queryEmbedding: number[],
  config: SpreadingActivationConfig,
): ActivationResult[] {
  // Get candidate chunks with embeddings
  const candidates = db
    .prepare(
      `SELECT id, path, start_line, end_line, embedding, source, text, schema_type
       FROM chunks
       LIMIT 200`,
    )
    .all() as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    embedding: string;
    source: string;
    text: string;
    schema_type: string | null;
  }>;

  const scored = candidates
    .map((row) => {
      const embedding = parseEmbedding(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      return {
        row,
        similarity,
      };
    })
    .filter((entry) => entry.similarity > 0.1)
    .toSorted((a, b) => b.similarity - a.similarity)
    .slice(0, 20); // Top 20 initial nodes

  return scored.map((entry) => ({
    id: entry.row.id,
    path: entry.row.path,
    startLine: entry.row.start_line,
    endLine: entry.row.end_line,
    activation: entry.similarity * config.queryActivationBoost,
    depth: 0,
    source: entry.row.source,
    snippet: entry.row.text.slice(0, 200),
    schemaType: entry.row.schema_type ?? undefined,
  }));
}

/**
 * Find neighboring chunks through associations.
 */
function findNeighborChunks(
  db: DatabaseSync,
  chunkId: string,
  config: SpreadingActivationConfig,
): Array<{
  chunkId: string;
  path: string;
  startLine: number;
  endLine: number;
  edgeStrength: number;
  source: string;
  snippet: string;
  schemaType: string | null;
}> {
  // Get associations from this chunk
  const associations = db
    .prepare(
      `SELECT a.target_id, a.strength, c.path, c.start_line, c.end_line, c.source, c.text, c.schema_type
       FROM associations a
       JOIN chunks c ON c.id = a.target_id
       WHERE a.source_id = ? AND a.strength >= ?`,
    )
    .all(chunkId, config.activationThreshold) as Array<{
    target_id: string;
    strength: number;
    path: string;
    start_line: number;
    end_line: number;
    source: string;
    text: string;
    schema_type: string | null;
  }>;

  return associations.map((row) => ({
    chunkId: row.target_id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    edgeStrength: row.strength,
    source: row.source,
    snippet: row.text.slice(0, 200),
    schemaType: row.schema_type,
  }));
}

/**
 * Create an association between two chunks.
 */
export function createAssociation(
  db: DatabaseSync,
  sourceId: string,
  targetId: string,
  strength: number,
  type: string = "semantic",
  context?: string,
): void {
  const id = `${sourceId}-${targetId}-${Date.now()}`;
  db.prepare(
    `INSERT OR REPLACE INTO associations (id, source_id, target_id, strength, type, context, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sourceId, targetId, Math.min(1.0, Math.max(0, strength)), type, context ?? null, Date.now());
}

/**
 * Get all associations for a chunk.
 */
export function getChunkAssociations(
  db: DatabaseSync,
  chunkId: string,
): Array<{
  targetId: string;
  strength: number;
  type: string;
  context?: string;
}> {
  return db
    .prepare(
      `SELECT target_id, strength, type, context FROM associations
       WHERE source_id = ?
       ORDER BY strength DESC`,
    )
    .all(chunkId) as Array<{
    target_id: string;
    strength: number;
    type: string;
    context: string | null;
  }>;
}

/**
 * Get cross-domain associations (associations between different schema types).
 * Useful for "举一反三" - finding unexpected connections.
 */
export function getCrossDomainAssociations(
  db: DatabaseSync,
  limit: number = 20,
): Array<{
  sourceId: string;
  targetId: string;
  sourceSchema: string;
  targetSchema: string;
  strength: number;
}> {
  const rows = db
    .prepare(
      `SELECT a.source_id, a.target_id, a.strength,
              s.schema_type as source_schema, t.schema_type as target_schema
       FROM associations a
       JOIN chunks s ON s.id = a.source_id
       JOIN chunks t ON t.id = a.target_id
       WHERE s.schema_type != t.schema_type
         AND s.schema_type IS NOT NULL
         AND t.schema_type IS NOT NULL
       ORDER BY a.strength DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    source_id: string;
    target_id: string;
    strength: number;
    source_schema: string;
    target_schema: string;
  }>;

  return rows.map((row) => ({
    sourceId: row.source_id,
    targetId: row.target_id,
    sourceSchema: row.source_schema,
    targetSchema: row.target_schema,
    strength: row.strength,
  }));
}

/**
 * Get association statistics for the graph.
 */
export function getAssociationStats(
  db: DatabaseSync,
): {
  totalAssociations: number;
  avgStrength: number;
  byType: Record<string, number>;
  orphanedChunks: number; // Chunks with no associations
} {
  const total = db.prepare(`SELECT COUNT(*) as count FROM associations`).get() as { count: number };
  const avg = db.prepare(`SELECT AVG(strength) as avg FROM associations`).get() as { avg: number | null };

  const typeRows = db
    .prepare(`SELECT type, COUNT(*) as count FROM associations GROUP BY type`)
    .all() as Array<{ type: string; count: number }>;

  const byType: Record<string, number> = {};
  for (const row of typeRows) {
    byType[row.type] = row.count;
  }

  // Count orphaned chunks (no incoming or outgoing associations)
  const orphaned = db
    .prepare(
      `SELECT COUNT(*) as count FROM chunks
       WHERE id NOT IN (SELECT source_id FROM associations)
         AND id NOT IN (SELECT target_id FROM associations)`,
    )
    .get() as { count: number };

  return {
    totalAssociations: total.count,
    avgStrength: avg.avg ?? 0,
    byType,
    orphanedChunks: orphaned.count,
  };
}
