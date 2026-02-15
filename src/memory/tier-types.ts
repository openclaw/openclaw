/**
 * Memory Tier System — Type Definitions
 *
 * T0: Working Memory  — in-context knowledge (system prompt + conversation)
 * T1: Daily Memory    — today's events, uncompressed, organized by topic
 * T2: Short-term      — compressed knowledge from daily memories
 * T3: Long-term       — archived from short-term when recall frequency is low
 * T4: Foundational    — SOUL.md, USER.md, MEMORY.md, skills (always loaded)
 */

export type MemoryTier = "T0" | "T1" | "T2" | "T3" | "T4";

export type TierTransitionResult = {
  action: "compress" | "archive" | "promote" | "delete" | "skip";
  sourcePath: string;
  targetPath?: string;
  tier: MemoryTier;
  targetTier?: MemoryTier;
  reason: string;
};

export type MemoryTierEntry = {
  path: string;
  tier: MemoryTier;
  promotedAt?: number;
  recallCount: number;
  lastRecalledAt?: number;
  compressedFrom?: string;
  compressionModel?: string;
  compressionAt?: number;
};

export type ChunkRecallEntry = {
  chunkId: string;
  recalledAt: number;
  sessionKey?: string;
  query?: string;
  score?: number;
  tier: MemoryTier;
};

export type ResolvedTierConfig = {
  enabled: boolean;
  compression: {
    minAgeHours: number;
    maxCompressedTokens: number;
    model?: string;
    prompt?: string;
  };
  archival: {
    noRecallHours: number;
    maxRecallCount: number;
    recallWindowHours: number;
  };
  promotion: {
    minRecallCount: number;
    recallWindowHours: number;
    cooldownHours: number;
  };
  deletion: {
    noRecallHours: number;
    neverDelete: boolean;
  };
  searchWeights: {
    t1: number;
    t2: number;
    t3: number;
    t4: number;
  };
};
