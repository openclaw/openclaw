import { z } from "zod";
import { DmPolicySchema, GroupPolicySchema } from "./zod-schema.core.js";

export const SpixiAccountSchemaBase = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    quixiApiUrl: z.string().optional().default("http://localhost:8001"),
    mqttHost: z.string().optional().default("127.0.0.1"),
    mqttPort: z.number().int().positive().optional().default(1883),
    myWalletAddress: z.string().optional(),
    openclawRecipient: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  })
  .strict();

export const SpixiAccountSchema = SpixiAccountSchemaBase;

export const SpixiConfigSchema = SpixiAccountSchemaBase.extend({
  accounts: z.record(z.string(), SpixiAccountSchema.optional()).optional(),
});
