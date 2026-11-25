import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readNodePermissionDetails,
  type NodePermissionRequest,
} from "../../../packages/gateway-protocol/src/node-permissions.js";
import { emitAgentEventForOwner, emitAgentEventForRunContext } from "../../infra/agent-events.js";
import { getAgentRunContext, getAgentRunContextOwnership } from "../../infra/agent-run-registry.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const CAPABILITY_NAMES: Record<string, string> = {
  notifications: "Notifications",
  accessibility: "Accessibility",
  eventPosting: "Event Posting",
  screenRecording: "Screen Recording",
  camera: "Camera",
  microphone: "Microphone",
  speechRecognition: "Speech Recognition",
  location: "Location",
  computerControl: "Computer Control",
  canvas: "Canvas",
};

/** A native refusal belongs to the requesting run, never a payload-supplied session. */
export function publishNodePermissionMissing(params: {
  error: unknown;
  nodeId: string;
  nodeName?: string;
  command: string;
  client?: GatewayClient | null;
  agentRuntimeIdentity?: AgentRuntimeIdentity;
  context: Pick<GatewayRequestContext, "validateAgentRuntimeApprovalAuthority">;
}): { permissionMissing: NodePermissionRequest; message: string } | undefined {
  const error = asOptionalObjectRecord(params.error);
  const details =
    error?.code === "PERMISSION_MISSING" ? readNodePermissionDetails(error.details) : undefined;
  if (!details) {
    return undefined;
  }
  const permissionMissing: NodePermissionRequest = {
    nodeId: params.nodeId,
    ...(params.nodeName ? { nodeName: params.nodeName } : {}),
    command: params.command,
    ...details,
  };
  const identity = params.agentRuntimeIdentity ?? params.client?.internal?.agentRuntimeIdentity;
  let shownCard = false;
  if (identity && params.context.validateAgentRuntimeApprovalAuthority?.(identity) === true) {
    const runId = identity.operationalRunInstance.runId;
    const runContext = getAgentRunContext(runId);
    const owner = getAgentRunContextOwnership(runId)?.exclusiveClaimId;
    if (runContext) {
      const event = {
        runId: identity.operationalRunInstance.runId,
        lifecycleGeneration: identity.delegatedAuthority.lifecycleGeneration,
        sessionKey: identity.sessionKey,
        agentId: identity.agentId,
        stream: "notice" as const,
        data: { phase: "warning", kind: "permission_missing", permissionMissing },
      };
      const emitted = owner
        ? emitAgentEventForOwner(event, owner)
        : emitAgentEventForRunContext(event, runContext);
      shownCard = emitted && runContext.isControlUiVisible !== false;
    }
  }
  const names = details.capabilities.map((id) => CAPABILITY_NAMES[id] ?? id).join(", ");
  const node = params.nodeName ? `${params.nodeName} (${params.nodeId})` : params.nodeId;
  return {
    permissionMissing,
    message: [
      `PERMISSION_MISSING: ${names} required on node ${node} (${details.state}).`,
      shownCard
        ? "The user has been shown a Grant card in the chat."
        : "Grant access in the OpenClaw Mac app: Settings → This Mac → Permissions.",
      "Do not retry until the user confirms that access has been granted.",
    ].join(" "),
  };
}
