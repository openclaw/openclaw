/**
 * Cross-Domain Association Discovery
 *
 * Inspired by human creative insight and analogical thinking:
 * - The brain can find unexpected connections between disparate domains
 * - "Insight" often comes from linking concepts that don't normally connect
 * - Creative problem-solving involves bridging distant concepts
 *
 * This module implements:
 * - Discovery of latent links between different schema types
 * - Shared feature extraction for cross-domain similarity
 * - "Aha moment" triggering - finding surprising connections
 */

import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity, parseEmbedding } from "./internal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("cross-domain-discovery");

export interface CrossDomainLink {
  sourceId: string;
  sourceContent: string;
  sourceSchema: string;
  targetId: string;
  targetContent: string;
  targetSchema: string;
  sharedFeatures: string[];
  linkStrength: number;
  discoveryType: "semantic" | "structural" | "temporal" | "emotional";
  insightPotential: number; // 0-1, how surprising/insightful this connection is
}

export interface CrossDomainConfig {
  /** Minimum schema difference to consider "cross-domain" */
  minSchemaDistance: number;
  /** Minimum insight potential to include in results */
  minInsightPotential: number;
  /** Maximum results to return */
  maxResults: number;
  /** Maximum pairs to evaluate per run */
  maxPairsPerRun: number;
  /** Schema hierarchy distance map (for calculating schema distance) */
  schemaHierarchy: Map<string, string>;
}

export const DEFAULT_CROSS_DOMAIN_CONFIG: CrossDomainConfig = {
  minSchemaDistance: 2, // e.g., "causal" and "procedural" are close (1), "causal" and "episodic" are far (3)
  minInsightPotential: 0.4,
  maxResults: 20,
  maxPairsPerRun: 1000,
  schemaHierarchy: new Map([
    ["temporal", "episodic"],
    ["spatial", "entity"],
    ["causal", "procedural"],
    ["social", "episodic"],
    ["evaluation", "semantic"],
    ["entity", "semantic"],
    ["procedural", "semantic"],
    ["episodic", "semantic"],
    ["semantic", "semantic"], // Root
  ]),
};

/** Calculate distance between two schemas based on hierarchy */
function schemaDistance(schema1: string, schema2: string, hierarchy: Map<string, string>): number {
  if (schema1 === schema2) return 0;
  if (!hierarchy.has(schema1) || !hierarchy.has(schema2)) return 3; // Max distance for unknown

  // Find paths to root
  const path1 = getSchemaPath(schema1, hierarchy);
  const path2 = getSchemaPath(schema2, hierarchy);

  // Find LCA
  const set1 = new Set(path1);
  for (const s of path2) {
    if (set1.has(s)) {
      // Distance = depth1 + depth2 - 2 * depth(LCA)
      const lcaDepth = path1.indexOf(s);
      return path1.length + path2.length - 2 * lcaDepth;
    }
  }

  return path1.length + path2.length; // No common ancestor
}

function getSchemaPath(schema: string, hierarchy: Map<string, string>): string[] {
  const path: string[] = [schema];
  let current = schema;
  while (hierarchy.has(current)) {
    current = hierarchy.get(current)!;
    path.push(current);
  }
  return path;
}

/**
 * Discover cross-domain associations between memories.
 *
 * This is the "creative insight" engine - finding unexpected connections
 * that might lead to "Aha!" moments.
 */
export function discoverCrossDomainAssociations(
  db: DatabaseSync,
  config: Partial<CrossDomainConfig> = {},
): CrossDomainLink[] {
  const cfg: CrossDomainConfig = { ...DEFAULT_CROSS_DOMAIN_CONFIG, ...config };

  log.info("starting cross-domain association discovery");

  // Get all chunks with schema types
  const chunks = db
    .prepare(
      `SELECT id, text, embedding, schema_type, salience FROM chunks
       WHERE schema_type IS NOT NULL
       LIMIT ?`,
    )
    .all(cfg.maxPairsPerRun) as Array<{
    id: string;
    text: string;
    embedding: string;
    schema_type: string;
    salience: number;
  }>;

  if (chunks.length < 2) {
    return [];
  }

  const results: CrossDomainLink[] = [];
  let evaluated = 0;

  // Evaluate pairs
  for (let i = 0; i < chunks.length && results.length < cfg.maxResults; i++) {
    for (let j = i + 1; j < chunks.length && results.length < cfg.maxResults; j++) {
      const a = chunks[i];
      const b = chunks[j];

      evaluated++;

      // Skip if same schema (not cross-domain)
      if (a.schema_type === b.schema_type) continue;

      // Calculate schema distance
      const schemaDist = schemaDistance(a.schema_type, b.schema_type, cfg.schemaHierarchy);
      if (schemaDist < cfg.minSchemaDistance) continue;

      // Calculate embedding similarity
      const embeddingA = parseEmbedding(a.embedding);
      const embeddingB = parseEmbedding(b.embedding);
      const semanticSimilarity = cosineSimilarity(embeddingA, embeddingB);

      // Calculate insight potential
      // High insight = distant schemas + moderate semantic similarity
      // (too similar = obvious, too different = irrelevant)
      const insightPotential = calculateInsightPotential(
        schemaDist,
        semanticSimilarity,
        a.salience,
        b.salience,
      );

      if (insightPotential < cfg.minInsightPotential) continue;

      // Extract shared features (simple keyword overlap for now)
      const sharedFeatures = extractSharedFeatures(a.text, b.text);

      // Determine discovery type
      const discoveryType = classifyDiscovery(a.text, b.text, a.schema_type, b.schema_type);

      results.push({
        sourceId: a.id,
        sourceContent: a.text.slice(0, 100),
        sourceSchema: a.schema_type,
        targetId: b.id,
        targetContent: b.text.slice(0, 100),
        targetSchema: b.schema_type,
        sharedFeatures,
        linkStrength: semanticSimilarity,
        discoveryType,
        insightPotential,
      });
    }
  }

  log.info(`evaluated ${evaluated} pairs, found ${results.length} cross-domain links`);

  // Sort by insight potential descending
  return results.toSorted((a, b) => b.insightPotential - a.insightPotential);
}

/**
 * Calculate insight potential based on schema distance and semantic similarity.
 *
 * Intuition:
 * - Very similar schemas + high similarity = obvious (low insight)
 * - Very distant schemas + low similarity = irrelevant (low insight)
 * - Distant schemas + moderate similarity = potential insight!
 */
function calculateInsightPotential(
  schemaDistance: number,
  semanticSimilarity: number,
  salienceA: number,
  salienceB: number,
): number {
  // Schema novelty (0-1): distant schemas are more novel
  const schemaNovelty = Math.min(1.0, schemaDistance / 4);

  // Semantic relevance (0-1): moderate similarity is best
  // Sweet spot around 0.4-0.7
  const semanticRelevance = 1 - Math.abs(semanticSimilarity - 0.5) * 2;

  // Salience bonus: connecting high-salience memories is more valuable
  const avgSalience = (salienceA + salienceB) / 2;
  const salienceBonus = avgSalience * 0.2;

  // Combined: schema novelty matters most for insight
  const potential = schemaNovelty * 0.5 + semanticRelevance * 0.3 + salienceBonus;

  return Math.min(1.0, Math.max(0, potential));
}

/**
 * Extract shared features between two texts (simple keyword overlap).
 */
function extractSharedFeatures(textA: string, textB: string): string[] {
  const wordsA = new Set(
    textA
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]/g, ""))
      .filter((w) => w.length > 3),
  );

  const wordsB = new Set(
    textB
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]/g, ""))
      .filter((w) => w.length > 3),
  );

  const shared: string[] = [];
  for (const word of wordsA) {
    if (wordsB.has(word) && !shared.includes(word)) {
      shared.push(word);
    }
  }

  return shared.slice(0, 5); // Top 5 shared features
}

/**
 * Classify the type of cross-domain discovery.
 */
function classifyDiscovery(
  textA: string,
  textB: string,
  schemaA: string,
  schemaB: string,
): "semantic" | "structural" | "temporal" | "emotional" {
  const lowerA = textA.toLowerCase();
  const lowerB = textB.toLowerCase();

  // Temporal indicators
  if (/yesterday|last week|month|when|before|after/.test(lowerA + lowerB)) {
    return "temporal";
  }

  // Emotional indicators
  if (/feel|happy|sad|love|hate|important|excited/.test(lowerA + lowerB)) {
    return "emotional";
  }

  // Structural (cause-effect patterns)
  if (/because|therefore|so|result|reason|why/.test(lowerA + lowerB)) {
    return "structural";
  }

  // Default to semantic
  return "semantic";
}

/**
 * Find "bridge" concepts that connect two otherwise distant domains.
 * This is useful for explaining how two concepts might be related.
 */
export function findBridgeConcepts(
  db: DatabaseSync,
  domainA: string,
  domainB: string,
): Array<{
  bridgeSchema: string;
  connectionFromA: string;
  connectionToB: string;
  explanation: string;
}> {
  const bridges: Array<{
    bridgeSchema: string;
    connectionFromA: string;
    connectionToB: string;
    explanation: string;
  }> = [];

  // Common bridge schemas
  const commonBridges: Array<{
    schema: string;
    connectionA: string;
    connectionB: string;
    explanation: string;
  }> = [
    {
      schema: "causal",
      connectionA: `${domainA} leads to`,
      connectionB: `results in ${domainB}`,
      explanation: "因果桥",
    },
    {
      schema: "temporal",
      connectionA: `${domainA} happened before`,
      connectionB: `which preceded ${domainB}`,
      explanation: "时间桥",
    },
    {
      schema: "evaluation",
      connectionA: `${domainA} is important because`,
      connectionB: `it affects ${domainB}`,
      explanation: "评估桥",
    },
  ];

  for (const bridge of commonBridges) {
    bridges.push({
      bridgeSchema: bridge.schema,
      connectionFromA: bridge.connectionA,
      connectionToB: bridge.connectionB,
      explanation: bridge.explanation,
    });
  }

  return bridges;
}

/**
 * Get cross-domain statistics for the memory graph.
 */
export function getCrossDomainStats(
  db: DatabaseSync,
): {
  totalCrossDomain: number;
  bySchemaPair: Array<{ schemaA: string; schemaB: string; count: number }>;
  avgInsightPotential: number;
  mostInsightfulPair: { schemaA: string; schemaB: string; insight: number } | null;
} {
  const rows = db
    .prepare(
      `SELECT c1.schema_type as schema_a, c2.schema_type as schema_b,
              COUNT(*) as count,
              AVG(a.strength) as avg_insight
       FROM associations a
       JOIN chunks c1 ON c1.id = a.source_id
       JOIN chunks t2 ON t2.id = a.target_id
       WHERE c1.schema_type != c2.schema_type
         AND c1.schema_type IS NOT NULL
         AND c2.schema_type IS NOT NULL
       GROUP BY c1.schema_type, c2.schema_type
       ORDER BY count DESC`,
    )
    .all() as Array<{
    schema_a: string;
    schema_b: string;
    count: number;
    avg_insight: number;
  }>;

  const mostInsightful = rows.length > 0 ? rows.reduce((max, r) => (r.avg_insight > max.avg_insight ? r : max)) : null;

  return {
    totalCrossDomain: rows.reduce((sum, r) => sum + r.count, 0),
    bySchemaPair: rows.map((r) => ({
      schemaA: r.schema_a,
      schemaB: r.schema_b,
      count: r.count,
    })),
    avgInsightPotential: rows.length > 0 ? rows.reduce((sum, r) => sum + r.avg_insight, 0) / rows.length : 0,
    mostInsightfulPair:
      mostInsightful
        ? {
            schemaA: mostInsightful.schema_a,
            schemaB: mostInsightful.schema_b,
            insight: mostInsightful.avg_insight,
          }
        : null,
  };
}
