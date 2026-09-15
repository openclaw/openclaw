import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveNodeCommandAllowlist,
  resolveRequiredNodeCommandAuthority,
} from "../node-command-policy.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { readNodeSessionWithheldCommands } from "../node-registry.js";
import { deviceUnavailableText, resolveDeviceWorkerAvailability } from "./device-provider.js";

/**
 * Paired-device inventory eligibility (connection, session-host consent, command
 * authority, and worker slots) plus session-scoped placement blockers.
 * Workspace symlink portability and Codex remote-exec prepared OpenAI auth are
 * projected onto environments.list as disabledReason when preflight knows them,
 * so the session host picker hard-disables before dispatch.
 */

/** Operator-facing reason when a workspace cannot sync to paired devices. */
export const SESSION_PLACEMENT_WORKSPACE_SYMLINKS_REASON =
  "Workspace contains absolute symlinks and can't be synced to a paired device.";

/** Operator-facing reason when Codex remote-exec lacks prepared OpenAI auth. */
export const SESSION_PLACEMENT_PREPARED_AUTH_REASON =
  'Codex remote-exec requires prepared OpenAI auth with appServer.homeScope="agent"; ambient credentials and native Codex auth are not accepted.';

export type SessionPlacementPreflight = Readonly<{
  workspaceHasEscapingSymlinks?: boolean;
  missingPreparedAuth?: boolean;
}>;

/** Stacks session-scoped placement blockers into one disabledReason sentence list. */
export function resolveSessionPlacementDisabledReason(
  preflight: SessionPlacementPreflight | undefined,
): string | undefined {
  if (!preflight) {
    return undefined;
  }
  const reasons: string[] = [];
  if (preflight.workspaceHasEscapingSymlinks) {
    reasons.push(SESSION_PLACEMENT_WORKSPACE_SYMLINKS_REASON);
  }
  if (preflight.missingPreparedAuth) {
    reasons.push(SESSION_PLACEMENT_PREPARED_AUTH_REASON);
  }
  return reasons.length > 0 ? reasons.join(" ") : undefined;
}
type DevicePlacementEligibility =
  | { ok: true; availableSlots: number; node: NodeWorkerSupervisorNodeProof }
  | { ok: false; error: string };

/** Raised only before a dispatch begins workspace preparation. */
export class DevicePlacementUnavailableError extends Error {
  constructor(
    readonly deviceId: string,
    message: string,
  ) {
    super(message);
  }
}

export async function resolveDevicePlacementEligibility(params: {
  environmentService: object | undefined;
  deviceId: string;
  runtimeId?: string;
  requirement: DevicePlacementRequirement | undefined;
  config: OpenClawConfig;
  sessionPlacement?: SessionPlacementPreflight;
  currentNode?: {
    nodeId: string;
    connId?: string;
    pairingGeneration?: string;
    platform?: string;
    deviceFamily?: string;
    declaredCommands?: readonly string[];
    commands?: readonly string[];
  };
}): Promise<DevicePlacementEligibility> {
  const { deviceId, requirement } = params;
  const sessionDisabledReason = resolveSessionPlacementDisabledReason(params.sessionPlacement);
  if (sessionDisabledReason) {
    return { ok: false, error: sessionDisabledReason };
  }
  if (!requirement) {
    return {
      ok: false,
      error: `runtime ${params.runtimeId ?? "selection"} does not support paired-device placement; select a compatible runtime or cloud worker provider`,
    };
  }
  const availability = await resolveDeviceWorkerAvailability(params.environmentService, deviceId);
  if (!availability.available || !availability.node) {
    return { ok: false, error: deviceUnavailableText(deviceId, availability) };
  }
  const node = availability.node;
  if (
    node.nodeId !== deviceId ||
    (params.currentNode &&
      (params.currentNode.nodeId !== node.nodeId ||
        (params.currentNode.connId && params.currentNode.connId !== node.connId) ||
        (params.currentNode.pairingGeneration &&
          params.currentNode.pairingGeneration !== node.pairingGeneration)))
  ) {
    return {
      ok: false,
      error: deviceUnavailableText(deviceId, {
        available: false,
        unavailableReason: "disconnected",
      }),
    };
  }
  const declaredCommands = [...node.commands];
  const allowlist = resolveNodeCommandAllowlist(params.config, {
    ...(params.currentNode?.platform ? { platform: params.currentNode.platform } : {}),
    ...(params.currentNode?.deviceFamily ? { deviceFamily: params.currentNode.deviceFamily } : {}),
    commands: declaredCommands,
    approvedCommands: declaredCommands,
  });
  const requiredNodeCommand = resolveRequiredNodeCommandAuthority({
    requiredCommands: requirement.requiredNodeCommands,
    declaredCommands: params.currentNode?.declaredCommands ?? declaredCommands,
    effectiveCommands: params.currentNode?.commands ?? declaredCommands,
    withheldCommands: params.currentNode ? readNodeSessionWithheldCommands(params.currentNode) : [],
    allowlist,
  });
  if (requiredNodeCommand && requiredNodeCommand.state !== "invocable") {
    return {
      ok: false,
      error: `paired-device command ${requiredNodeCommand.command} is not enabled or approved for ${deviceId}; enable it in gateway.nodes.commands.allow and approve the command on the node`,
    };
  }
  if (requirement.consumesWorkerSlot && node.workerHost.capacity.available <= 0) {
    return {
      ok: false,
      error: deviceUnavailableText(deviceId, {
        available: false,
        unavailableReason: "at-capacity",
      }),
    };
  }
  return { ok: true, availableSlots: node.workerHost.capacity.available, node };
}
