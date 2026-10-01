import { z } from "zod";

export const NODE_INSTALLED_APP_LAUNCH_COMMAND = "device.apps.launch";
export const InstalledAppIdSchema = z.string().regex(/^linux-desktop:[A-Za-z0-9_.-]+\.desktop$/);
export const InstalledAppRevisionSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const InstalledAppLaunchRequestSchema = z.strictObject({
  appId: InstalledAppIdSchema,
  appRevision: InstalledAppRevisionSchema,
});
export type InstalledAppLaunchRequest = z.infer<typeof InstalledAppLaunchRequestSchema>;
export const InstalledAppListToolParamsSchema = z.strictObject({
  action: z.literal("app_list"),
  node: z.string().min(1).max(256),
  query: z.string().min(1).max(256).optional(),
  limit: z.number().int().positive().max(20).optional(),
});
/** Gateway-added identity for the node's independent per-agent execution policy. */
// Internal node execution facts are sanitized by the existing exec approval owner.
const AppExecutionSchema = z.strictObject({
  command: z.array(z.string()).length(1),
  env: z.undefined().optional(),
  rawCommand: z.string().nullable().optional(),
  systemRunPlan: z.record(z.string(), z.unknown()).optional(),
  cwd: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  sessionKey: z.string().nullable().optional(),
  timeoutMs: z.number().nullable().optional(),
  approved: z.boolean().optional(),
  approvalDecision: z.string().optional(),
  approvalSource: z.string().optional(),
  runId: z.string().optional(),
  suppressNotifyOnExit: z.boolean().optional(),
  turnSourceChannel: z.string().optional(),
  turnSourceTo: z.string().optional(),
  turnSourceAccountId: z.string().optional(),
  turnSourceThreadId: z.union([z.string(), z.number()]).optional(),
});
export const InstalledAppLaunchWireSchema = InstalledAppLaunchRequestSchema.extend({
  execution: AppExecutionSchema,
});
export const InstalledAppLaunchDispatchSchema = InstalledAppLaunchRequestSchema.extend({
  agentId: z.string().min(1).max(256),
  execution: AppExecutionSchema.optional(),
});
export const InstalledAppLaunchReadySchema = InstalledAppLaunchRequestSchema.extend({
  type: z.literal("installed-app-launch.ready"),
});
export const InstalledAppLaunchPermitSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("installed-app-launch.allow"),
    validForMs: z.number().int().positive().max(5000),
  }),
  z.strictObject({ type: z.literal("installed-app-launch.deny") }),
]);

/** Closed tool shape: no Gateway override, implicit target, arguments, or environment. */
export const InstalledAppLaunchToolParamsSchema = InstalledAppLaunchRequestSchema.extend({
  action: z.literal("app_launch"),
  node: z.string().min(1).max(256),
});

export const InstalledAppStartedSchema = InstalledAppLaunchRequestSchema.extend({
  status: z.literal("process-started"),
  pid: z.number().int().positive(),
}).strip();
