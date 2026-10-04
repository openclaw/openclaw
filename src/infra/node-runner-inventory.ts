import { z } from "zod";
import { WORKER_BUNDLE_PREWARM_VERSION } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { parseWorkerCapacity } from "../../packages/gateway-protocol/src/worker-capacity.js";
import { workerProtocolObject } from "../worker/protocol-record.js";

export const NODE_RUNNER_INVENTORY_UPDATE_METHOD = "node.runnerInventory.update";
export const NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE = "node-worker-supervisor-v6";
const RETIRED_NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURES = [
  "node-worker-supervisor-v1",
  "node-worker-supervisor-v2",
  "node-worker-supervisor-v3",
  "node-worker-supervisor-v4",
  "node-worker-supervisor-v5",
] as const;
export const NODE_WORKER_BUNDLE_RETENTION_VERSION = 1;
export const NODE_WORKER_BUNDLE_STATUS_VERSION = 1;
export const NODE_WORKER_PORTAL_STREAM_VERSION = 1;
export const NODE_WORKER_ENVIRONMENT_SESSION_VERSION = 1;
export const NODE_WORKER_STATUS_WAIT_VERSION = 1;
export const NODE_WORKER_PREPARED_WORKSPACE_VERSION = 1;
export const NODE_WORKER_HOST_DISABLED_REASON_MAX_LENGTH = 1_024;
// Couples the lease owner with foreground tree ownership; neither rolls out alone.
export const NODE_WORKER_WORKSPACE_QUIESCENCE_VERSION = 1;

// Supervisors predating launchToolNames admit this closed vocabulary: OpenClaw 2026.9.6
// is the only published release that passes the worker-turn launch gate. Retire with the next dialect.
const LEGACY_NODE_WORKER_LAUNCH_TOOL_NAMES = Object.freeze([
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "browser",
  "computer",
  "skill_workshop",
  "sessions_spawn",
  "sessions_send",
  "portal",
]);

export const NODE_RUNNER_UPDATE_REQUIRED_ISSUE = {
  code: "update-required",
  action: "update-and-reconnect",
  updateCommand: "openclaw update",
  headlessReconnectCommand: "openclaw node restart",
} as const;

export type NodeRunnerInventoryIssue =
  | typeof NODE_RUNNER_UPDATE_REQUIRED_ISSUE
  | { code: "worker-host-unavailable"; message: string };
const CapacitySnapshot = z.transform((value, context) => {
  const capacity = parseWorkerCapacity(value);
  if (!capacity) {
    context.addIssue({ code: "custom", message: "invalid worker capacity" });
    return z.NEVER;
  }
  return capacity;
});
const LaunchToolNames = z
  .array(z.string().min(1).max(64))
  .max(64)
  .refine((names) => new Set(names).size === names.length);
const WorkerHost = z
  .union([
    workerProtocolObject({
      enabled: z.literal(false),
      reason: z
        .string()
        .max(NODE_WORKER_HOST_DISABLED_REASON_MAX_LENGTH)
        .refine((value) => value.trim().length > 0)
        .optional(),
    }),
    workerProtocolObject({
      enabled: z.literal(true),
      capacity: CapacitySnapshot,
      bundlePrewarm: z.literal(WORKER_BUNDLE_PREWARM_VERSION).optional(),
      bundleRetention: z.literal(NODE_WORKER_BUNDLE_RETENTION_VERSION).optional(),
      bundleStatus: z.literal(NODE_WORKER_BUNDLE_STATUS_VERSION).optional(),
      portalStream: z.literal(NODE_WORKER_PORTAL_STREAM_VERSION).optional(),
      environmentSession: z.literal(NODE_WORKER_ENVIRONMENT_SESSION_VERSION).optional(),
      statusWait: z.literal(NODE_WORKER_STATUS_WAIT_VERSION).optional(),
      preparedWorkspace: z.literal(NODE_WORKER_PREPARED_WORKSPACE_VERSION).optional(),
      capturedExecPolicy: z.literal(true).optional(),
      workspaceQuiescence: z.literal(NODE_WORKER_WORKSPACE_QUIESCENCE_VERSION).optional(),
      launchToolNames: LaunchToolNames.optional(),
      idleRetention: z.literal(true).optional(),
    }).refine(
      (host) =>
        (host.bundleStatus === undefined || host.bundleRetention !== undefined) &&
        (host.capacity.reclaimableIdle === undefined || host.idleRetention === true),
    ),
  ])
  .transform((host) => {
    // Optional undefined values are absent in the reconnect declaration.
    for (const [key, value] of Object.entries(host)) {
      if (value === undefined) {
        Reflect.deleteProperty(host, key);
      }
    }
    return host;
  });
export type NodeWorkerCapacitySnapshot = Readonly<z.infer<typeof CapacitySnapshot>>;
export type NodeWorkerHostDeclaration = z.infer<typeof WorkerHost>;

const RunnerInventory = z.union([
  workerProtocolObject({ protocolFeatures: z.tuple([]).readonly() }),
  workerProtocolObject({
    protocolFeatures: z
      .tuple([z.enum(RETIRED_NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURES)])
      .readonly(),
    workerRuns: z.unknown().optional(),
    workerHost: z.unknown().optional(),
  })
    .refine((value) => Object.keys(value).length <= 2)
    // Retired payloads never become consent or launch authority; only their marker drives recovery.
    .transform(({ protocolFeatures }) => ({ protocolFeatures })),
  workerProtocolObject({
    protocolFeatures: z.tuple([z.literal(NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE)]).readonly(),
    workerHost: WorkerHost,
  }),
]);
export type NodeRunnerInventoryDeclaration = z.infer<typeof RunnerInventory>;

/** Parses the closed reconnect-scoped node-host runner declaration. */
export function parseNodeRunnerInventoryDeclaration(
  value: unknown,
): NodeRunnerInventoryDeclaration | null {
  return RunnerInventory.safeParse(value).data ?? null;
}

export function formatNodeRunnerInventoryIssue(
  nodeId: string,
  issue: NodeRunnerInventoryIssue,
): string {
  return issue.code === "worker-host-unavailable"
    ? `device worker node ${nodeId} cannot host sessions: ${issue.message}`
    : `device worker node ${nodeId} requires an update before it can host sessions; run ${issue.updateCommand}, then reconnect it (for a headless node, run ${issue.headlessReconnectCommand})`;
}

class NodeRunnerUpdateRequiredError extends Error {
  readonly code = "node_runner_update_required";

  constructor(nodeId: string) {
    super(formatNodeRunnerInventoryIssue(nodeId, NODE_RUNNER_UPDATE_REQUIRED_ISSUE));
    this.name = "NodeRunnerUpdateRequiredError";
  }
}

export function createNodeRunnerInventoryIssueError(
  nodeId: string,
  issue: NodeRunnerInventoryIssue,
): Error {
  return issue.code === "update-required"
    ? new NodeRunnerUpdateRequiredError(nodeId)
    : new Error(formatNodeRunnerInventoryIssue(nodeId, issue));
}

/** Worker execution requires the node to preserve the Gateway's captured exec policy. */
export function resolveNodeWorkerExecutionIssue(
  workerHost: NodeWorkerHostDeclaration,
): NodeRunnerInventoryIssue | undefined {
  return workerHost.enabled && workerHost.capturedExecPolicy !== true
    ? NODE_RUNNER_UPDATE_REQUIRED_ISSUE
    : undefined;
}

export function resolveNodeWorkerLaunchToolNames(
  workerHost: NodeWorkerHostDeclaration | undefined,
): readonly string[] {
  return (
    (workerHost?.enabled && workerHost.launchToolNames) || LEGACY_NODE_WORKER_LAUNCH_TOOL_NAMES
  );
}
