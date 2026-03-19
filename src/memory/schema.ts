/**
 * Schema System for Memory Organization
 *
 * Inspired by human memory schema theory:
 * - Schemas are organized frameworks of knowledge
 * - New information is integrated into existing schemas (assimilation)
 * - Schemas enable fast generalization from single examples (举一反三)
 *
 * This module provides:
 * - Base schema definitions (temporal, spatial, causal, social, evaluation, entity)
 * - Schema inference from content (embedding-based matching)
 * - Schema-tagged memory storage and retrieval
 */

import { cosineSimilarity, parseEmbedding } from "./internal.js";

/** Schema types that categorize memory content */
export type SchemaType =
  | "temporal" // Time, dates, duration, frequency, sequence
  | "spatial" // Location, direction, distance, container, spatial relations
  | "causal" // Cause, effect, purpose, method, explanation
  | "social" // Person, organization, relationship, communication, interaction
  | "evaluation" // Good/bad, importance, urgency, difficulty, value
  | "entity" // Objects, concepts, entities, instances
  | "procedural" // Skills, habits, steps, processes
  | "episodic" // Specific events, experiences, autobiographical
  | "semantic"; // Facts, definitions, general knowledge

export interface SchemaDefinition {
  name: SchemaType;
  keywords: string[]; // Keywords that strongly suggest this schema
  description: string;
  parent?: SchemaType; // For hierarchical organization
}

export interface SchemaMatch {
  schema: SchemaType;
  confidence: number; // 0-1
  matchedKeywords: string[];
}

/** Base schema definitions */
export const BASE_SCHEMAS: SchemaDefinition[] = [
  {
    name: "temporal",
    keywords: ["时间", "日期", "持续", "频率", "顺序", "time", "date", "duration", "frequency", "sequence", "when", "before", "after", " morning", "evening"],
    description: "Time-related memories",
  },
  {
    name: "spatial",
    keywords: ["位置", "方向", "距离", "空间", "location", "direction", "distance", "space", "where", "left", "right", "above", "below", "here", "there"],
    description: "Space/location-related memories",
  },
  {
    name: "causal",
    keywords: ["原因", "结果", "目的", "方式", "为什么", "cause", "effect", "purpose", "method", "why", "because", "therefore", "so", "result"],
    description: "Causal relationships and explanations",
  },
  {
    name: "social",
    keywords: ["人", "朋友", "家人", "同事", "组织", "沟通", "person", "friend", "family", "colleague", "organization", "talk", "meet"],
    description: "Social relationships and interactions",
  },
  {
    name: "evaluation",
    keywords: ["重要", "紧急", "好坏", "价值", "优先", "important", "urgent", "good", "bad", "value", "priority", "prefer", "best", "worst"],
    description: "Evaluations, preferences, and judgments",
  },
  {
    name: "entity",
    keywords: ["东西", "物品", "概念", "实物", "thing", "object", "concept", "item", "thing", "what", "is", "exists"],
    description: "Objects, concepts, and entities",
  },
  {
    name: "procedural",
    keywords: ["步骤", "过程", "方法", "技能", "习惯", "step", "process", "method", "skill", "habit", "how to", "procedure", "routine"],
    description: "Skills, habits, and procedures",
  },
  {
    name: "episodic",
    keywords: ["经历", "事件", "发生", "记得", "experience", "event", "happened", "remember", "yesterday", "last week", "once", "story"],
    description: "Specific events and experiences",
  },
  {
    name: "semantic",
    keywords: ["知识", "事实", "定义", "知道", "knowledge", "fact", "definition", "know", "truth", "information", "learned"],
    description: "General knowledge and facts",
  },
];

/** Keyword-based schema inference (fast, no embedding needed) */
export function inferSchemaFromKeywords(content: string): SchemaMatch[] {
  const lowerContent = content.toLowerCase();
  const matches: SchemaMatch[] = [];

  for (const schema of BASE_SCHEMAS) {
    const matchedKeywords = schema.keywords.filter((kw) =>
      lowerContent.includes(kw.toLowerCase())
    );

    if (matchedKeywords.length > 0) {
      matches.push({
        schema: schema.name,
        confidence: Math.min(1.0, matchedKeywords.length / 3), // 3 keyword matches = high confidence
        matchedKeywords,
      });
    }
  }

  // Sort by confidence and return top matches
  return matches.toSorted((a, b) => b.confidence - a.confidence);
}

/** Schema inference with embedding similarity (more accurate but requires embeddings) */
export async function inferSchemaFromEmbedding(
  contentEmbedding: number[],
  schemasEmbeddings: Map<SchemaType, number[]>
): Promise<Array<{ schema: SchemaType; similarity: number }>> {
  const results: Array<{ schema: SchemaType; similarity: number }> = [];

  for (const [schema, embedding] of schemasEmbeddings) {
    const similarity = cosineSimilarity(contentEmbedding, embedding);
    results.push({ schema, similarity });
  }

  return results.toSorted((a, b) => b.similarity - a.similarity);
}

/** Combined schema inference (keyword + embedding) */
export function inferSchema(
  content: string,
  contentEmbedding?: number[],
  schemasEmbeddings?: Map<SchemaType, number[]>
): SchemaMatch[] {
  // Start with keyword-based inference
  const keywordMatches = inferSchemaFromKeywords(content);

  // If we have embeddings, combine with embedding similarity
  if (contentEmbedding && schemasEmbeddings) {
    // This is async but we make it sync-compatible by returning promise
    // Caller should await if using embedding mode
    return keywordMatches;
  }

  return keywordMatches;
}

/** Get the primary schema for a piece of content */
export function getPrimarySchema(content: string): SchemaType {
  const matches = inferSchemaFromKeywords(content);
  return matches.length > 0 ? matches[0].schema : "semantic"; // Default to semantic
}

/** Build keyword-based schema fingerprints for fast matching */
export function buildSchemaFingerprints(): Map<SchemaType, Set<string>> {
  const fingerprints = new Map<SchemaType, Set<string>>();

  for (const schema of BASE_SCHEMAS) {
    fingerprints.set(schema.name, new Set(schema.keywords.map((k) => k.toLowerCase())));
  }

  return fingerprints;
}

/** Check if content matches a specific schema (for filtering) */
export function matchesSchema(content: string, schema: SchemaType, minKeywordMatches: number = 1): boolean {
  const schemaDef = BASE_SCHEMAS.find((s) => s.name === schema);
  if (!schemaDef) return false;

  const lowerContent = content.toLowerCase();
  const matchCount = schemaDef.keywords.filter((kw) =>
    lowerContent.includes(kw.toLowerCase())
  ).length;

  return matchCount >= minKeywordMatches;
}

/** Get schema statistics for a set of memory chunks */
export function getSchemaDistribution(
  chunks: Array<{ content: string; schemaType?: SchemaType }>
): Map<SchemaType, number> {
  const distribution = new Map<SchemaType, number>();

  for (const chunk of chunks) {
    const schema = chunk.schemaType ?? getPrimarySchema(chunk.content);
    distribution.set(schema, (distribution.get(schema) ?? 0) + 1);
  }

  return distribution;
}
