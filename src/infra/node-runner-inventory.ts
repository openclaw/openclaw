import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { WORKER_BUNDLE_PREWARM_VERSION } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { parseWorkerSlotSummary } from "../shared/node-list-parse.js";
import { workerProtocolObject } from "../worker/protocol-record.js";
import { WORKER_TOOL_NAMES, type WorkerToolName } from "../worker/tool-authority.js";

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
] satisfies WorkerToolName[]);

export const NODE_RUNNER_UPDATE_REQUIRED_ISSUE = {
  code: "update-required",
  action: "update-and-reconnect",
  updateCommand: "openclaw update",
  headlessReconnectCommand: "openclaw node restart",
} as const;

export type NodeRunnerInventoryIssue = typeof NODE_RUNNER_UPDATE_REQUIRED_ISSUE;
const CapacitySnapshot = z.transform((value, context) => {
  const capacity = parseWorkerSlotSummary(value);
  if (!capacity) {
    context.addIssue({ code: "custom", message: "invalid worker capacity" });
    return z.NEVER;
  }
  return capacity;
});
// Unknown names are ignored so newer nodes can still declare to this Gateway.
const LaunchToolNames = z
  .array(z.string().min(1).max(64))
  .max(64)
  .refine((names) => new Set(names).size === names.length)
  .transform((names): readonly WorkerToolName[] => {
    const declared = new Set<string>(names);
    return WORKER_TOOL_NAMES.filter((name) => declared.has(name));
  });
const WorkerHost = z.union([
  workerProtocolObject({ enabled: z.literal(false) }),
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
    launchToolNames: LaunchToolNames.optional(),
  }).refine((host) => host.bundleStatus === undefined || host.bundleRetention !== undefined),
]);
export type NodeWorkerCapacitySnapshot = Readonly<z.infer<typeof CapacitySnapshot>>;
export type NodeWorkerHostDeclaration = z.infer<typeof WorkerHost>;

export type NodeRunnerInventoryDeclaration =
  | { protocolFeatures: readonly [] }
  | {
      protocolFeatures: readonly [
        (typeof RETIRED_NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURES)[number],
      ];
    }
  | {
      protocolFeatures: readonly [typeof NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE];
      workerHost: NodeWorkerHostDeclaration;
    };

/** Parses the closed reconnect-scoped node-host runner declaration. */
export function parseNodeRunnerInventoryDeclaration(
  value: unknown,
): NodeRunnerInventoryDeclaration | null {
  if (!isRecord(value) || !Array.isArray(value.protocolFeatures)) {
    return null;
  }
  const keys = Object.keys(value);
  if (value.protocolFeatures.length === 0) {
    return keys.length === 1 && keys.includes("protocolFeatures") ? { protocolFeatures: [] } : null;
  }
  if (value.protocolFeatures.length !== 1) {
    return null;
  }
  const feature = value.protocolFeatures[0];
  const retiredFeature = RETIRED_NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURES.find(
    (candidate) => candidate === feature,
  );
  if (retiredFeature) {
    // Retired payloads never become consent or launch authority; only their marker drives recovery.
    return keys.length <= 2 &&
      keys.every(
        (key) => key === "protocolFeatures" || key === "workerRuns" || key === "workerHost",
      )
      ? { protocolFeatures: [retiredFeature] }
      : null;
  }
  if (feature !== NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE || keys.length !== 2) {
    return null;
  }
  const workerHost = WorkerHost.safeParse(value.workerHost).data;
  if (workerHost) {
    // Optional undefined values are absent in the reconnect declaration.
    const fields: Record<string, unknown> = workerHost;
    for (const key of Object.keys(fields)) {
      if (fields[key] === undefined) {
        delete fields[key];
      }
    }
  }
  return workerHost
    ? { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE], workerHost }
    : null;
}

export function formatNodeRunnerUpdateRequired(
  nodeId: string,
  issue: NodeRunnerInventoryIssue,
): string {
  return `device worker node ${nodeId} requires an update before it can host sessions; run ${issue.updateCommand}, then reconnect it (for a headless node, run ${issue.headlessReconnectCommand})`;
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
): readonly WorkerToolName[] {
  return (
    (workerHost?.enabled && workerHost.launchToolNames) || LEGACY_NODE_WORKER_LAUNCH_TOOL_NAMES
  );
}
