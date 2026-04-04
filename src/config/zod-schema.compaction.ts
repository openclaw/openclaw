import { z } from "zod";
import { isValidNonNegativeByteSizeString } from "./byte-size.js";

/**
 * Shared compaction configuration schema used by both agent defaults
 * and per-agent entries. Per-agent compaction merges on top of defaults
 * (shallow merge), allowing agents to override specific fields like
 * reserveTokens or mode without re-specifying the entire config.
 */
export const CompactionConfigSchema = z
  .object({
    mode: z.union([z.literal("default"), z.literal("safeguard")]).optional(),
    reserveTokens: z.number().int().nonnegative().optional(),
    keepRecentTokens: z.number().int().positive().optional(),
    reserveTokensFloor: z.number().int().nonnegative().optional(),
    maxHistoryShare: z.number().min(0.1).max(0.9).optional(),
    customInstructions: z.string().optional(),
    identifierPolicy: z
      .union([z.literal("strict"), z.literal("off"), z.literal("custom")])
      .optional(),
    identifierInstructions: z.string().optional(),
    recentTurnsPreserve: z.number().int().min(0).max(12).optional(),
    qualityGuard: z
      .object({
        enabled: z.boolean().optional(),
        maxRetries: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    postIndexSync: z.enum(["off", "async", "await"]).optional(),
    postCompactionSections: z.array(z.string()).optional(),
    model: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    truncateAfterCompaction: z.boolean().optional(),
    memoryFlush: z
      .object({
        enabled: z.boolean().optional(),
        softThresholdTokens: z.number().int().nonnegative().optional(),
        forceFlushTranscriptBytes: z
          .union([
            z.number().int().nonnegative(),
            z
              .string()
              .refine(isValidNonNegativeByteSizeString, "Expected byte size string like 2mb"),
          ])
          .optional(),
        prompt: z.string().optional(),
        systemPrompt: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
