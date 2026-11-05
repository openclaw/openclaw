import { z } from "zod";

export const NativeExecApprovalEnableModeSchema = z.union([z.boolean(), z.literal("auto")]);

const ExecApprovalForwardTargetSchema = z.strictObject({
  channel: z.string().min(1),
  to: z.string().min(1),
  accountId: z.string().optional(),
  threadId: z.union([z.string(), z.number()]).optional(),
});

const ExecApprovalForwardingSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    mode: z.union([z.literal("session"), z.literal("targets"), z.literal("both")]).optional(),
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    targets: z.array(ExecApprovalForwardTargetSchema).optional(),
  })
  .optional();

// Raw IDs are scoped by the authenticated Slack account at the decision boundary.
const SlackPluginApproverSchema = z.string().regex(/^(?:team:T[A-Z0-9]+:user:)?[UW][A-Z0-9]+$/i);

const PluginSlackApproversSchema = z.strictObject({
  approvers: z.array(SlackPluginApproverSchema).optional(),
  plugins: z
    .record(
      z.string(),
      z.strictObject({
        approvers: z.array(SlackPluginApproverSchema).optional(),
        tools: z
          .record(z.string(), z.strictObject({ approvers: z.array(SlackPluginApproverSchema) }))
          .optional(),
      }),
    )
    .optional(),
});

const PluginApprovalConfigSchema = ExecApprovalForwardingSchema.unwrap()
  .extend({ slack: PluginSlackApproversSchema.optional() })
  .optional();

export const ApprovalsSchema = z
  .strictObject({
    exec: ExecApprovalForwardingSchema,
    plugin: PluginApprovalConfigSchema,
  })
  .optional();
