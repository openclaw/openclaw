import { z } from "zod";

const DmPolicySchema = z.enum(["open", "allowlist", "pairing", "disabled"]);

const MessengerAccountConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    pageAccessToken: z.string().optional(),
    appSecret: z.string().optional(),
    verifyToken: z.string().optional(),
    tokenFile: z.string().optional(),
    secretFile: z.string().optional(),
    name: z.string().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    responsePrefix: z.string().optional(),
    webhookPath: z.string().optional(),
  })
  .strict();

export const MessengerConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    pageAccessToken: z.string().optional(),
    appSecret: z.string().optional(),
    verifyToken: z.string().optional(),
    tokenFile: z.string().optional(),
    secretFile: z.string().optional(),
    name: z.string().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    responsePrefix: z.string().optional(),
    webhookPath: z.string().optional(),
    accounts: z.record(z.string(), MessengerAccountConfigSchema.optional()).optional(),
  })
  .strict();

export type MessengerConfigSchemaType = z.infer<typeof MessengerConfigSchema>;
