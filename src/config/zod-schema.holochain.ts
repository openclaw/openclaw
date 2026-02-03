import { z } from "zod";

export const HolochainModeSchema = z.union([
  z.literal("disabled"),
  z.literal("hybrid"),
  z.literal("full-p2p"),
]);

export const HolochainConductorConfigSchema = z
  .object({
    binPath: z.string().optional(),
    adminPort: z.number().int().positive().optional(),
    appPort: z.number().int().positive().optional(),
    autoStart: z.boolean().optional(),
    dataDir: z.string().optional(),
  })
  .strict()
  .optional();

export const HolochainSessionStorageConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    fallbackToLocal: z.boolean().optional(),
    retentionDays: z.number().int().positive().optional(),
    encryption: z.boolean().optional(),
  })
  .strict()
  .optional();

export const HolochainSecurityConfigSchema = z
  .object({
    promptValidation: z.boolean().optional(),
    auditLog: z.boolean().optional(),
    rateLimitPerHour: z.number().int().positive().optional(),
    sandboxHardening: z.boolean().optional(),
  })
  .strict()
  .optional();

export const HolochainA2AWalletConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    seedPhrase: z.string().optional(),
    network: z
      .union([z.literal("mainnet-beta"), z.literal("devnet"), z.literal("testnet")])
      .optional(),
  })
  .strict()
  .optional();

export const HolochainA2AConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    wallet: HolochainA2AWalletConfigSchema,
    commissionRate: z.number().min(0).max(1).optional(),
    maxPingPongTurns: z.number().int().min(0).max(10).optional(),
  })
  .strict()
  .optional();

export const HolochainP2PConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    bootstrapNodes: z.array(z.string()).optional(),
    networkId: z.string().optional(),
    kitsuneTransport: z.boolean().optional(),
  })
  .strict()
  .optional();

export const HolochainConfigSchema = z
  .object({
    mode: HolochainModeSchema.optional(),
    conductor: HolochainConductorConfigSchema,
    sessionStorage: HolochainSessionStorageConfigSchema,
    security: HolochainSecurityConfigSchema,
    a2a: HolochainA2AConfigSchema,
    p2p: HolochainP2PConfigSchema,
  })
  .strict()
  .optional();
