/**
 * Reconstructive Memory Retrieval
 *
 * Inspired by human memory's constructive nature:
 * - Memories are not played back like recordings
 * - They are reconstructed from fragments when retrieved
 * - Reconstruction is influenced by context, schema, and current understanding
 * - This is why memories can be distorted or biased
 *
 * This module implements:
 * - Memory reconstruction with context enrichment
 * - Association-based memory elaboration
 * - Schema-guided memory completion
 * - Confidence scoring for reconstructed memories
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { cosineSimilarity, parseEmbedding } from "./internal.js";

const log = createSubsystemLogger("reconstructive-retrieval");

export interface ReconstructedMemory {
  /** Original chunk data */
  chunkId: string;
  path: string;
  startLine: number;
  endLine: number;
  originalText: string;
  /** Reconstructed/elaborated version */
  reconstruction: string;
  /** How confident we are in this reconstruction (0-1) */
  confidence: number;
  /** Supporting memories that informed reconstruction */
  supportingMemories: Array<{
    id: string;
    snippet: string;
    relationship: string;
  }>;
  /** Schema context used for reconstruction */
  schemaContext: string[];
  /** Whether this is a "strong" memory (well-supported) or "weak" (fragile) */
  strength: "strong" | "medium" | "weak";
}

export interface ReconstructionContext {
  /** Current query/reason for retrieval */
  query?: string;
  /** Recent conversation context */
  recentMessages?: string[];
  /** User's known preferences/relevant facts */
  userContext?: string[];
  /** Time context */
  temporalContext?: string;
}

export interface ReconstructiveRetrievalConfig {
  /** Maximum supporting memories to include */
  maxSupportingMemories: number;
  /** Minimum association strength to consider for support */
  minSupportStrength: number;
  /** Maximum temporal distance for context (ms) */
  maxTemporalDistance: number;
  /** Confidence threshold for "strong" reconstruction */
  strongConfidenceThreshold: number;
  /** Confidence threshold for "medium" reconstruction */
  mediumConfidenceThreshold: number;
}

export const DEFAULT_RECONSTRUCTION_CONFIG: ReconstructiveRetrievalConfig = {
  maxSupportingMemories: 3,
  minSupportStrength: 0.4,
  maxTemporalDistance: 7 * 24 * 60 * 60 * 1000, // 7 days
  strongConfidenceThreshold: 0.8,
  mediumConfidenceThreshold: 0.5,
};

/**
 * Retrieve and reconstruct a memory with context enrichment.
 *
 * Unlike simple search results, this returns:
 * 1. The original memory
 * 2. A reconstructed version with context
 * 3. Supporting related memories
 * 4. Confidence scoring
 */
export function reconstructiveRetrieve(
  db: DatabaseSync,
  chunkId: string,
  context: ReconstructionContext = {},
  config: Partial<ReconstructiveRetrievalConfig> = {},
): ReconstructedMemory | null {
  const cfg: ReconstructiveRetrievalConfig = { ...DEFAULT_RECONSTRUCTION_CONFIG, ...config };

  // Get the target chunk
  const chunk = db
    .prepare(
      `SELECT id, path, start_line, end_line, text, embedding, schema_type, salience, access_count, updated_at
       FROM chunks WHERE id = ?`,
    )
    .get(chunkId) as {
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    embedding: string;
    schema_type: string | null;
    salience: number;
    access_count: number;
    updated_at: number;
  } | null;

  if (!chunk) {
    return null;
  }

  // Get supporting memories through associations
  const supportingMemories = getSupportingMemories(db, chunk.id, cfg);

  // Build schema context
  const schemaContext = buildSchemaContext(chunk.schema_type, context);

  // Generate reconstruction
  const reconstruction = generateReconstruction(chunk, supportingMemories, schemaContext, context);

  // Calculate confidence
  const confidence = calculateConfidence(chunk, supportingMemories);

  // Determine strength
  const strength = confidence >= cfg.strongConfidenceThreshold ? "strong" : confidence >= cfg.mediumConfidenceThreshold ? "medium" : "weak";

  return {
    chunkId: chunk.id,
    path: chunk.path,
    startLine: chunk.start_line,
    endLine: chunk.end_line,
    originalText: chunk.text,
    reconstruction,
    confidence,
    supportingMemories,
    schemaContext,
    strength,
  };
}

/**
 * Get memories that support/enhance a given memory.
 */
function getSupportingMemories(
  db: DatabaseSync,
  chunkId: string,
  cfg: ReconstructiveRetrievalConfig,
): Array<{ id: string; snippet: string; relationship: string }> {
  // Get direct associations
  const associations = db
    .prepare(
      `SELECT a.target_id, a.strength, a.type, c.text
       FROM associations a
       JOIN chunks c ON c.id = a.target_id
       WHERE a.source_id = ? AND a.strength >= ?
       ORDER BY a.strength DESC
       LIMIT ?`,
    )
    .all(chunkId, cfg.minSupportStrength, cfg.maxSupportingMemories) as Array<{
    target_id: string;
    strength: number;
    type: string;
    text: string;
  }>;

  return associations.map((a) => ({
    id: a.target_id,
    snippet: a.text.slice(0, 100),
    relationship: describeRelationship(a.type, a.strength),
  }));
}

/**
 * Describe the relationship between memories.
 */
function describeRelationship(type: string, strength: number): string {
  const typeLabels: Record<string, string> = {
    semantic: "语义相关",
    temporal: "时间接近",
    causal: "因果关联",
    episodic: "共同经历",
    schema: "图式关联",
  };

  const label = typeLabels[type] || type;
  const strengthLabel = strength > 0.7 ? "强" : strength > 0.4 ? "中" : "弱";

  return `${strengthLabel}${label}`;
}

/**
 * Build context from schema type.
 */
function buildSchemaContext(schemaType: string | null, context: ReconstructionContext): string[] {
  const schemaContexts: Record<string, string[]> = {
    temporal: ["这件事发生在", "时间点", "持续时间"],
    spatial: ["发生地点", "空间位置", "方向"],
    causal: ["原因", "结果", "为什么"],
    social: ["涉及的人", "关系", "沟通"],
    evaluation: ["重要程度", "价值评估", "优先级"],
    entity: ["概念", "定义", "实例"],
    procedural: ["步骤", "过程", "方法"],
    episodic: ["经历", "事件", "故事"],
    semantic: ["事实", "知识", "信息"],
  };

  const base = schemaType && schemaContexts[schemaType] ? schemaContexts[schemaType] : ["记忆"];

  if (context.query) {
    base.push(`查询: ${context.query}`);
  }

  if (context.temporalContext) {
    base.push(`时间背景: ${context.temporalContext}`);
  }

  return base;
}

/**
 * Generate a reconstruction of the memory with context.
 *
 * Phase 1: Simple template-based reconstruction
 * Future: Could use LLM for more sophisticated reconstruction
 */
function generateReconstruction(
  chunk: {
    text: string;
    schema_type: string | null;
    salience: number;
    access_count: number;
  },
  supporting: Array<{ snippet: string; relationship: string }>,
  schemaContext: string[],
  context: ReconstructionContext,
): string {
  // Start with original text
  let reconstruction = chunk.text;

  // Add schema context
  if (schemaContext.length > 0) {
    const schemaNote = schemaContext.slice(0, 2).join("; ");
    reconstruction = `[${schemaNote}] ${reconstruction}`;
  }

  // Add supporting memory hints
  if (supporting.length > 0) {
    const supportHints = supporting.map((s) => `(${s.relationship}: "${s.snippet.slice(0, 30)}...")`).join(", ");
    reconstruction = `${reconstruction}\n\n相关记忆: ${supportHints}`;
  }

  // Add access pattern hint
  if (chunk.access_count > 5) {
    reconstruction = `${reconstruction}\n\n[这是多次被访问的重要记忆]`;
  } else if (chunk.access_count === 0) {
    reconstruction = `${reconstruction}\n\n[这是新记忆，可能需要更多上下文来验证]`;
  }

  // Add contextual hints from user context
  if (context.userContext && context.userContext.length > 0) {
    const userNote = context.userContext.slice(0, 2).join("; ");
    reconstruction = `${reconstruction}\n\n用户背景: ${userNote}`;
  }

  return reconstruction;
}

/**
 * Calculate confidence in the reconstruction.
 */
function calculateConfidence(
  chunk: {
    salience: number;
    access_count: number;
  },
  supporting: Array<{ id: string }>,
): number {
  // Base confidence from salience
  let confidence = chunk.salience * 0.4;

  // Boost from access count (log scale)
  const accessBoost = Math.log(chunk.access_count + 1) / 10;
  confidence += accessBoost * 0.3;

  // Boost from supporting memories
  const supportBoost = Math.min(0.3, supporting.length * 0.1);
  confidence += supportBoost;

  return Math.min(1.0, Math.max(0, confidence));
}

/**
 * Batch reconstructive retrieval for multiple chunks.
 */
export function reconstructiveRetrieveBatch(
  db: DatabaseSync,
  chunkIds: string[],
  context: ReconstructionContext = {},
  config: Partial<ReconstructiveRetrievalConfig> = {},
): ReconstructedMemory[] {
  return chunkIds
    .map((id) => reconstructiveRetrieve(db, id, context, config))
    .filter((r): r is ReconstructedMemory => r !== null);
}

/**
 * Get memory with "memory chain" - sequences of related memories.
 * This helps understand the narrative flow of memories.
 */
export function getMemoryChain(
  db: DatabaseSync,
  startChunkId: string,
  maxDepth: number = 3,
): Array<{
  chunk: { id: string; path: string; text: string; schema_type: string | null };
  depth: number;
  relationship: string;
}> {
  const chain: Array<{
    chunk: { id: string; path: string; text: string; schema_type: string | null };
    depth: number;
    relationship: string;
  }> = [];

  const visited = new Set<string>();
  let currentIds = [startChunkId];
  let depth = 0;

  while (currentIds.length > 0 && depth < maxDepth) {
    const nextIds: string[] = [];

    for (const id of currentIds) {
      if (visited.has(id)) continue;
      visited.add(id);

      const chunk = db
        .prepare(
          `SELECT id, path, text, schema_type FROM chunks WHERE id = ?`,
        )
        .get(id) as { id: string; path: string; text: string; schema_type: string | null } | null;

      if (!chunk) continue;

      const relationship = depth === 0 ? "起点" : `关联层级 ${depth}`;

      chain.push({
        chunk,
        depth,
        relationship,
      });

      // Get next level of associations
      const associations = db
        .prepare(
          `SELECT target_id, type FROM associations WHERE source_id = ? LIMIT 3`,
        )
        .all(id) as Array<{ target_id: string; type: string }>;

      for (const assoc of associations) {
        if (!visited.has(assoc.target_id)) {
          nextIds.push(assoc.target_id);
        }
      }
    }

    currentIds = [...new Set(nextIds)];
    depth++;
  }

  return chain;
}

/**
 * Get retrieval quality metrics.
 */
export function getRetrievalQualityMetrics(
  db: DatabaseSync,
): {
  avgConfidence: number;
  strongPercent: number;
  weakPercent: number;
  supportedPercent: number; // % with supporting memories
  orphanedPercent: number; // % with no associations
} {
  const chunks = db
    .prepare(
      `SELECT salience, access_count FROM chunks`,
    )
    .all() as Array<{
    salience: number;
    access_count: number;
  }>;

  if (chunks.length === 0) {
    return {
      avgConfidence: 0,
      strongPercent: 0,
      weakPercent: 0,
      supportedPercent: 0,
      orphanedPercent: 100,
    };
  }

  const supportedCount = (
    db
      .prepare(`SELECT COUNT(DISTINCT source_id) as count FROM associations`)
      .get() as { count: number }
  ).count;

  let strongCount = 0;
  let weakCount = 0;
  let totalConfidence = 0;

  for (const chunk of chunks) {
    const confidence = Math.min(1.0, chunk.salience * 0.5 + Math.log(chunk.access_count + 1) / 10 * 0.5);
    totalConfidence += confidence;

    if (confidence >= 0.8) strongCount++;
    if (confidence < 0.5) weakCount++;
  }

  return {
    avgConfidence: totalConfidence / chunks.length,
    strongPercent: (strongCount / chunks.length) * 100,
    weakPercent: (weakCount / chunks.length) * 100,
    supportedPercent: (supportedCount / chunks.length) * 100,
    orphanedPercent: ((chunks.length - supportedCount) / chunks.length) * 100,
  };
}
