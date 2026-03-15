import { z } from "zod";

const ApprovalForwardTargetSchema = z
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
    targets: z.array(ApprovalForwardTargetSchema).optional(),
  })
  .strict()
  .optional();

const HttpApprovalForwardingSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.union([z.literal("session"), z.literal("targets"), z.literal("both")]).optional(),
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    targets: z.array(ApprovalForwardTargetSchema).optional(),
  })
  .strict()
  .optional();

const HttpAllowlistEntrySchema = z
  .object({
    pattern: z.string().min(1),
  })
  .strict();

const HttpSecurityEnum = z.enum(["deny", "allowlist", "full"]);
const HttpAskEnum = z.enum(["off", "on-miss", "always"]);

const HttpApprovalsAgentSchema = z
  .object({
    security: HttpSecurityEnum.optional(),
    ask: HttpAskEnum.optional(),
    askFallback: HttpSecurityEnum.optional(),
    allowlist: z.array(HttpAllowlistEntrySchema).optional(),
  })
  .strict();

const HttpApprovalsToolConfigSchema = z
  .object({
    security: HttpSecurityEnum.optional(),
    ask: HttpAskEnum.optional(),
    askFallback: HttpSecurityEnum.optional(),
    agents: z.record(z.string(), HttpApprovalsAgentSchema).optional(),
    allowlist: z.array(HttpAllowlistEntrySchema).optional(),
  })
  .strict()
  .optional();

export const ApprovalsSchema = z
  .object({
    exec: ExecApprovalForwardingSchema,
    http: HttpApprovalForwardingSchema,
    httpPolicy: HttpApprovalsToolConfigSchema,
  })
  .strict()
  .optional();
