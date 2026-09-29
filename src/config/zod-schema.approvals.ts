// Defines command approval Zod schema fragments.
import { z } from "zod";

/** Native exec approval mode accepted by config. */
export const NativeExecApprovalEnableModeSchema = z.union([z.boolean(), z.literal("auto")]);

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

// Raw IDs are scoped by the authenticated Slack account at the decision boundary.
const SlackPluginApproverSchema = z.string().regex(/^(?:team:T[A-Z0-9]+:user:)?[UW][A-Z0-9]+$/i);

const PluginSlackApproversSchema = z
  .object({
    approvers: z.array(SlackPluginApproverSchema).optional(),
    plugins: z
      .record(
        z.string(),
        z
          .object({
            approvers: z.array(SlackPluginApproverSchema).optional(),
            tools: z
              .record(
                z.string(),
                z.object({ approvers: z.array(SlackPluginApproverSchema) }).strict(),
              )
              .optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const PluginApprovalConfigSchema = ExecApprovalForwardingSchema.unwrap()
  .extend({ slack: PluginSlackApproversSchema.optional() })
  .optional();

export const ApprovalsSchema = z
  .object({
    exec: ExecApprovalForwardingSchema,
    plugin: PluginApprovalConfigSchema,
  })
  .strict()
  .optional();
