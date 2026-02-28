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

const ToolApprovalSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.union([z.literal("selected"), z.literal("mutating")]).optional(),
    tools: z.array(z.string()).optional(),
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    security: z.union([z.literal("deny"), z.literal("allowlist"), z.literal("full")]).optional(),
    ask: z.union([z.literal("off"), z.literal("on-miss"), z.literal("always")]).optional(),
    timeoutMs: z.number().int().positive().optional(),
    failClosed: z.boolean().optional(),
    allowAlwaysTtlMs: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const ApprovalsSchema = z
  .object({
    exec: ExecApprovalForwardingSchema,
    tools: ToolApprovalSchema,
  })
  .strict()
  .optional();
