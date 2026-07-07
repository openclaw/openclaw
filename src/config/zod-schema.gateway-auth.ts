import { z } from "zod";
import { SecretInputSchema } from "./zod-schema.core.js";
import { sensitive } from "./zod-schema.sensitive.js";

export const GatewayAuthSchema = z
  .object({
    mode: z
      .union([
        z.literal("none"),
        z.literal("token"),
        z.literal("password"),
        z.literal("trusted-proxy"),
      ])
      .optional(),
    token: SecretInputSchema.optional().register(sensitive),
    password: SecretInputSchema.optional().register(sensitive),
    allowTailscale: z.boolean().optional(),
    requireTailscaleSharedSecret: z.boolean().optional(),
    rateLimit: z
      .object({
        maxAttempts: z.number().optional(),
        windowMs: z.number().optional(),
        lockoutMs: z.number().optional(),
        exemptLoopback: z.boolean().optional(),
      })
      .strict()
      .optional(),
    trustedProxy: z
      .object({
        userHeader: z.string().min(1, "userHeader is required for trusted-proxy mode"),
        requiredHeaders: z.array(z.string()).optional(),
        allowUsers: z.array(z.string()).optional(),
        allowLoopback: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
