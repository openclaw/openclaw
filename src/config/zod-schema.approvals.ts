import { z } from "zod";

const ExecApprovalForwardTargetSchema = z
  .object({
    channel: z.string().min(1),
    to: z.string().min(1),
    accountId: z.string().optional(),
    threadId: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

const ExecApprovalForwardingShape = {
  enabled: z.boolean().optional(),
  mode: z.union([z.literal("session"), z.literal("targets"), z.literal("both")]).optional(),
  agentFilter: z.array(z.string()).optional(),
  sessionFilter: z.array(z.string()).optional(),
  targets: z.array(ExecApprovalForwardTargetSchema).optional(),
};

const ExecApprovalForwardingSchema = z.object(ExecApprovalForwardingShape).strict().optional();

const PluginApprovalForwardingSchema = z
  .object({
    ...ExecApprovalForwardingShape,
    language: z.union([z.literal("original"), z.literal("simple")]).optional(),
  })
  .strict()
  .optional();

export const ApprovalsSchema = z
  .object({
    exec: ExecApprovalForwardingSchema,
    plugin: PluginApprovalForwardingSchema,
  })
  .strict()
  .optional();
