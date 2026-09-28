import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  ErrorCodes,
  errorShape,
  validateNodeListParams,
  validateNodePendingAckParams,
  type ConnectParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
} from "../../infra/device-pairing-node-state.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import {
  acknowledgePendingNodeActions,
  listPendingNodeActions,
  replacePendingNodeActionsForGeneration,
  type PendingNodeAction,
} from "../node-runtime-state.js";
import { nodeInvokePolicy } from "./nodes-policy.js";
import { respondPairingChanged } from "./nodes.shared.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function resolveAllowedPendingNodeActions(params: {
  nodeId: string;
  pairingGeneration: string;
  client: { connect?: ConnectParams | null } | null;
  cfg: OpenClawConfig;
}): PendingNodeAction[] {
  const pending = listPendingNodeActions({
    nodeId: params.nodeId,
    pairingGeneration: params.pairingGeneration,
    ttlMs: nodeInvokePolicy.pendingActionTtlMs,
  });
  if (pending.length === 0) {
    return pending;
  }
  // Re-filter queued actions against the node's current declared commands and
  // allowlist; app upgrades or permission changes can make old actions unsafe.
  const connect = params.client?.connect;
  const declaredCommands = Array.isArray(connect?.commands) ? connect.commands : [];
  const allowlist = resolveNodeCommandAllowlist(params.cfg, {
    platform: connect?.client?.platform,
    deviceFamily: connect?.client?.deviceFamily,
    caps: connect?.caps,
    commands: declaredCommands,
  });
  const allowed = pending.filter((entry) => {
    const result = isNodeCommandAllowed({
      command: entry.command,
      declaredCommands,
      allowlist,
    });
    return result.ok;
  });
  if (allowed.length !== pending.length) {
    replacePendingNodeActionsForGeneration({
      nodeId: params.nodeId,
      pairingGeneration: params.pairingGeneration,
      replacement: allowed,
      ttlMs: nodeInvokePolicy.pendingActionTtlMs,
    });
  }
  return allowed;
}

export function toPendingParamsJSON(params: unknown): string | undefined {
  try {
    return JSON.stringify(params);
  } catch {
    return undefined;
  }
}

async function withPendingNodeActions(
  options: GatewayRequestHandlerOptions,
  operation: (nodeId: string, pairingGeneration: string) => () => unknown,
): Promise<void> {
  const { respond, client, context } = options;
  const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
  const trimmedNodeId = normalizeOptionalString(nodeId) ?? "";
  if (!trimmedNodeId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
    return;
  }
  await respondUnavailableOnThrow(respond, async () => {
    const generation = await captureNodePairingGeneration(trimmedNodeId);
    if (!generation) {
      respondPairingChanged(respond);
      return;
    }
    const session = context.nodeRegistry.getForPairingGeneration(trimmedNodeId, generation.key);
    if (!session || session.connId !== client?.connId) {
      respondPairingChanged(respond);
      return;
    }
    const readResult = operation(trimmedNodeId, generation.key);
    if (!(await isNodePairingGenerationCurrent(generation))) {
      respondPairingChanged(respond);
      return;
    }
    respond(true, readResult(), undefined);
  });
}

export const nodePendingActionHandlers: GatewayRequestHandlers = {
  "node.pending.pull": async (options) => {
    const { params, respond, client, context } = options;
    if (!assertValidParams(params, validateNodeListParams, "node.pending.pull", respond)) {
      return;
    }
    await withPendingNodeActions(options, (nodeId, pairingGeneration) => {
      const pending = resolveAllowedPendingNodeActions({
        nodeId,
        pairingGeneration,
        client,
        cfg: context.getRuntimeConfig(),
      });
      return () => ({
        nodeId,
        actions: pending.map((entry) => ({
          id: entry.id,
          command: entry.command,
          paramsJSON: entry.paramsJSON ?? null,
          enqueuedAtMs: entry.enqueuedAtMs,
        })),
      });
    });
  },
  "node.pending.ack": async (options) => {
    const { params, respond } = options;
    if (!assertValidParams(params, validateNodePendingAckParams, "node.pending.ack", respond)) {
      return;
    }
    await withPendingNodeActions(options, (nodeId, pairingGeneration) => {
      const ackIds = normalizeUniqueTrimmedStringList(params.ids);
      const remaining = acknowledgePendingNodeActions({
        nodeId,
        pairingGeneration,
        ids: ackIds,
        ttlMs: nodeInvokePolicy.pendingActionTtlMs,
      });
      return () => ({ nodeId, ackedIds: ackIds, remainingCount: remaining.length });
    });
  },
};
