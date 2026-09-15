import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { EnvironmentSummary } from "../../../packages/gateway-protocol/src/index.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import {
  isNodeCommandAllowed,
  resolveNodeCommandAllowlist,
  resolveRequiredNodeCommandAuthority,
} from "../node-command-policy.js";
import { readNodeSessionWithheldCommands, type NodeSession } from "../node-registry.js";
import type { WorkerEnvironmentServiceRecord } from "../worker-environments/service-contract.js";
import type { WorkerEnvironmentState } from "../worker-environments/state.js";

export const GATEWAY_ENVIRONMENT: EnvironmentSummary = {
  id: "gateway",
  type: "local",
  label: "Gateway local",
  status: "available",
  platform: process.platform,
  sessionHost: true,
  trust: "persistent",
  capabilities: ["agent.run", "sessions", "tools", "workspace"],
};
const WORKER_STATUS: Record<WorkerEnvironmentState, EnvironmentSummary["status"]> = {
  requested: "starting",
  provisioning: "starting",
  bootstrapping: "starting",
  ready: "available",
  attached: "available",
  idle: "available",
  draining: "stopping",
  destroying: "stopping",
  destroyed: "unavailable",
  failed: "error",
  orphaned: "error",
};
function uniqueSortedStrings(...items: Array<readonly string[] | undefined>): string[] {
  return normalizeSortedUniqueTrimmedStringList(items.flatMap((item) => item ?? []));
}
export function summarizeNodeEnvironment(
  node: NodeListNode,
  config: Parameters<typeof resolveNodeCommandAllowlist>[0],
  requiredCommands: readonly string[],
  liveNode: NodeSession | undefined,
): EnvironmentSummary {
  const capabilities = uniqueSortedStrings(node.caps, node.commands);
  const platform = node.platform?.trim();
  const allowlist =
    node.connected === true
      ? resolveNodeCommandAllowlist(config, {
          platform: node.platform,
          deviceFamily: node.deviceFamily,
          commands: node.commands,
          approvedCommands: node.commands,
        })
      : undefined;
  const invocableCommands = allowlist
    ? uniqueSortedStrings(node.commands)
        .filter(
          (command) =>
            command.length <= 128 &&
            isNodeCommandAllowed({ command, declaredCommands: node.commands, allowlist }).ok,
        )
        .slice(0, 128)
    : [];
  const desktop = invocableCommands.includes(NODE_DESKTOP_STREAM_COMMAND);
  const requiredNodeCommand =
    allowlist && liveNode
      ? resolveRequiredNodeCommandAuthority({
          requiredCommands,
          declaredCommands: liveNode.declaredCommands,
          effectiveCommands: liveNode.commands,
          withheldCommands: readNodeSessionWithheldCommands(liveNode),
          allowlist,
        })
      : undefined;
  return {
    id: `node:${node.nodeId}`,
    type: "node",
    label: node.displayName ?? node.nodeId,
    status: node.connected ? "available" : "unavailable",
    ...(platform ? { platform } : {}),
    sessionHost: node.sessionHost === true,
    ...(node.workerSlots ? { workerSlots: { ...node.workerSlots } } : {}),
    ...(node.workerBundle ? { workerBundle: structuredClone(node.workerBundle) } : {}),
    ...(node.lastConnectedAtMs !== undefined ? { lastConnectedAtMs: node.lastConnectedAtMs } : {}),
    ...(node.lastDisconnectedAtMs !== undefined
      ? { lastDisconnectedAtMs: node.lastDisconnectedAtMs }
      : {}),
    ...(node.lastSeenAtMs !== undefined ? { lastSeenAtMs: node.lastSeenAtMs } : {}),
    ...(node.lastSeenReason ? { lastSeenReason: node.lastSeenReason } : {}),
    trust: "persistent",
    ...(desktop ? { desktop: true } : {}),
    ...(liveNode?.desktopAvailability
      ? { desktopAvailability: { ...liveNode.desktopAvailability } }
      : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(invocableCommands.length > 0 ? { invocableCommands } : {}),
    ...(requiredNodeCommand ? { requiredNodeCommand } : {}),
    ...(node.issues?.length ? { issues: [...node.issues] } : {}),
  };
}
export function summarizeWorkerEnvironment(
  record: WorkerEnvironmentServiceRecord,
  now = Date.now(),
): EnvironmentSummary {
  return {
    id: record.environmentId,
    type: "worker",
    status: WORKER_STATUS[record.state],
    ...(record.sharedHost === null
      ? {}
      : { trust: record.sharedHost ? "persistent" : "disposable" }),
    ...(record.desktopAvailable ? { desktop: true } : {}),
    ...(record.preparation
      ? { preparation: { purpose: record.preparation.purpose, key: record.preparation.key } }
      : {}),
    worker: {
      profileId: record.profileId,
      providerId: record.providerId,
      ...(record.leaseId ? { leaseId: record.leaseId } : {}),
      state: record.state,
      ageMs: Math.max(0, Math.trunc(now - record.createdAtMs)),
      ...(record.state === "idle" && record.idleSinceAtMs !== null
        ? { idleMs: Math.max(0, Math.trunc(now - record.idleSinceAtMs)) }
        : {}),
      attachedSessionIds: uniqueSortedStrings(record.attachedSessionIds),
      tunnelStatus: record.tunnelStatus,
      ...((record.state === "failed" || record.state === "orphaned") && record.error
        ? { error: record.error }
        : {}),
      ...(record.desktopAvailable ? { desktop: true } : {}),
      ...(record.desktopApps.length > 0 ? { desktopApps: [...record.desktopApps] } : {}),
    },
  };
}
