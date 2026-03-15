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

const ToolApprovalForwardingSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.union([z.literal("session"), z.literal("targets"), z.literal("both")]).optional(),
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    targets: z.array(ExecApprovalForwardTargetSchema).optional(),
  })
  .strict()
  .optional();

const ToolAllowlistEntrySchema = z
  .object({
    pattern: z.string().min(1),
  })
  .strict();

const ToolSecuritySchema = z.enum(["deny", "allowlist", "full"]);
const ToolAskSchema = z.enum(["off", "on-miss", "always"]);

const ToolApprovalsAgentSchema = z
  .object({
    security: ToolSecuritySchema.optional(),
    ask: ToolAskSchema.optional(),
    askFallback: ToolSecuritySchema.optional(),
    allowlist: z.array(ToolAllowlistEntrySchema).optional(),
  })
  .strict();

const ToolApprovalsToolConfigSchema = z
  .object({
    security: ToolSecuritySchema.optional(),
    ask: ToolAskSchema.optional(),
    askFallback: ToolSecuritySchema.optional(),
    agents: z.record(z.string(), ToolApprovalsAgentSchema).optional(),
    allowlist: z.array(ToolAllowlistEntrySchema).optional(),
  })
  .strict()
  .optional();

export const ApprovalsSchema = z
  .object({
    exec: ExecApprovalForwardingSchema,
    tool: ToolApprovalForwardingSchema,
    toolPolicy: ToolApprovalsToolConfigSchema,
  })
  .strict()
  .optional();
