import { z } from "zod";

const ExecApprovalForwardTargetSchema = z
  .object({
    channel: z.string().min(1),
    to: z.string().min(1),
    accountId: z.string().optional(),
    threadId: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

const ExecApprovalForwardingSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.union([z.literal("session"), z.literal("targets"), z.literal("both")]).optional(),
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    targets: z.array(ExecApprovalForwardTargetSchema).optional(),
  })
  .strict()
  .optional();

export const ApprovalsSchema = z
  .object({
    exec: ExecApprovalForwardingSchema,
    hitl: z
      .object({
        enabled: z.boolean().optional(),
        apiKey: z.string().optional(),
        loopId: z.string().optional(),
        callbackSecret: z.string().optional(),
        callbackUrl: z.string().optional(),
        timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
        defaultDecision: z
          .union([z.literal("allow-once"), z.literal("allow-always"), z.literal("deny")])
          .optional(),
        outbound: z
          .object({
            mode: z.union([z.literal("off"), z.literal("on-miss"), z.literal("always")]).optional(),
            allowlist: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        pluginHttp: z
          .object({
            mode: z.union([z.literal("off"), z.literal("on-miss"), z.literal("always")]).optional(),
            allowlist: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        webhook: z
          .object({
            maxBodyBytes: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
