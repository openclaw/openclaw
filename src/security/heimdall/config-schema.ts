/**
 * Heimdall Security Layer — Zod Schema
 *
 * Extracted from agent-defaults for reuse in per-channel config.
 */

import { z } from "zod";

const SenderTierLiteral = z.union([z.literal("owner"), z.literal("member"), z.literal("guest")]);

export const HeimdallRateLimitSchema = z
  .object({
    enabled: z.boolean().optional(),
    windowMs: z.number().int().positive().optional(),
    maxMessages: z.number().int().positive().optional(),
    guestMaxMessages: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const HeimdallAuditSchema = z
  .object({
    enabled: z.boolean().optional(),
    logBlockedTools: z.boolean().optional(),
    logRedactions: z.boolean().optional(),
    logRateLimits: z.boolean().optional(),
    logSanitization: z.boolean().optional(),
  })
  .strict()
  .optional();

export const HeimdallSchema = z
  .object({
    enabled: z.boolean().optional(),
    senderTiers: z
      .object({
        owners: z.array(z.union([z.string(), z.number()])).optional(),
        members: z.array(z.union([z.string(), z.number()])).optional(),
      })
      .strict()
      .optional(),
    defaultGuestPolicy: z.union([z.literal("deny"), z.literal("read-only")]).optional(),
    toolACL: z
      .array(
        z
          .object({
            pattern: z.string(),
            allowedTiers: z.array(SenderTierLiteral),
          })
          .strict(),
      )
      .optional(),
    outputFilter: z
      .object({
        enabled: z.boolean().optional(),
        customPatterns: z
          .array(
            z
              .object({
                name: z.string(),
                regex: z.string(),
                flags: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    sanitize: z
      .object({
        maxLength: z.number().int().positive().optional(),
        nfkcNormalize: z.boolean().optional(),
        controlCharDensityThreshold: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    rateLimit: HeimdallRateLimitSchema,
    audit: HeimdallAuditSchema,
  })
  .strict()
  .optional();
