import { z } from "zod";

export const QuotaSchema = z
  .object({
    enabled: z.boolean().optional(),
    storage: z
      .object({
        backend: z.union([z.literal("dynamodb"), z.literal("redis")]),
        dynamodb: z
          .object({
            tableName: z.string(),
            region: z.string().optional(),
            endpoint: z.string().optional(),
          })
          .strict()
          .optional(),
        redis: z
          .object({
            url: z.string().optional(),
            keyPrefix: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    plans: z
      .record(
        z.string(),
        z
          .object({
            tokenLimit: z.number().int().positive(),
            label: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    defaultPlan: z.string().optional().default("free"),
    customerHeader: z.string().optional().default("x-customer-id"),
    customerEnvVar: z.string().optional().default("OPENCLAW_CUSTOMER_ID"),
    quotaExceededMessage: z.string().optional(),
  })
  .strict()
  .optional();
