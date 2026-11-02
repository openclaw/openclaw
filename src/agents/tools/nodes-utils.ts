import crypto from "node:crypto";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getAgentToolAssistantTurnId } from "../../../packages/agent-core/src/tool-execution-context.js";
import { SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY } from "../../../packages/gateway-protocol/src/system-run-execution-context.js";
import { parseNodeList } from "../../shared/node-list-parse.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import { resolveNodeFromNodeList, resolveNodeIdFromNodeList } from "../../shared/node-resolve.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

export type { NodeListNode };

export function nodeToolIdempotencyKey(params: {
  command: "computer.act" | "mobile.ui.act";
  scope?: string;
  toolCallId: string;
  purpose?: "follow-up-observation";
}): string {
  const stableScope = params.scope?.trim();
  const stableCallId = params.toolCallId.trim();
  // Runner-normalized call ids are unique within an attempt, not across all runs.
  if (!stableScope || !stableCallId) {
    return crypto.randomUUID();
  }
  const parts = [stableScope, getAgentToolAssistantTurnId() ?? "", stableCallId, params.command];
  if (params.purpose) {
    parts.push(params.purpose);
  }
  // The automatic read shares a call id with input, but must never replay its result.
  const prefix = params.purpose ? "computer.observation" : params.command;
  // v2 versions scope + assistant turn + call id + command, not the wire contract.
  return `${prefix}:v2:${sha256Hex(JSON.stringify(parts))}`;
}

type DefaultNodeFallback = "none" | "first";

type DefaultNodeSelectionOptions = {
  capability?: string;
  fallback?: DefaultNodeFallback;
  preferLocalMac?: boolean;
};

function isLocalMacNode(node: NodeListNode): boolean {
  return (
    normalizeOptionalLowercaseString(node.platform)?.startsWith("mac") === true &&
    typeof node.nodeId === "string" &&
    node.nodeId.startsWith("mac-")
  );
}

function compareNewestTimestamp(a?: number, b?: number): number {
  const aValue = Number.isFinite(a) ? (a ?? 0) : -1;
  const bValue = Number.isFinite(b) ? (b ?? 0) : -1;
  return bValue - aValue;
}

export function selectDefaultNodeFromList(
  nodes: NodeListNode[],
  options: DefaultNodeSelectionOptions = {},
): NodeListNode | null {
  const capability = options.capability?.trim();
  const withCapability = capability
    ? nodes.filter((n) => (Array.isArray(n.caps) ? n.caps.includes(capability) : true))
    : nodes;
  if (withCapability.length === 0) {
    return null;
  }

  const connected = withCapability.filter((n) => n.connected);
  const candidates = connected.length > 0 ? connected : withCapability;
  if (candidates.length === 1) {
    return candidates.at(0) ?? null;
  }

  const preferLocalMac = options.preferLocalMac ?? true;
  if (preferLocalMac) {
    const local = candidates.filter(isLocalMacNode);
    if (local.length === 1) {
      return local.at(0) ?? null;
    }
  }

  const fallback = options.fallback ?? "none";
  if (fallback === "none") {
    return null;
  }

  // Once the pool is known to be offline, stale connection timestamps must not
  // outrank the durable last-seen signal used to choose the wake target.
  const recencyField = connected.length > 0 ? "connectedAtMs" : "lastSeenAtMs";
  return candidates.reduce<NodeListNode | null>((best, node) => {
    const order = best
      ? compareNewestTimestamp(node[recencyField], best[recencyField]) ||
        node.nodeId.localeCompare(best.nodeId)
      : -1;
    return order < 0 ? node : best;
  }, null);
}

function pickDefaultNode(nodes: NodeListNode[]): NodeListNode | null {
  return selectDefaultNodeFromList(nodes, {
    capability: "canvas",
    fallback: "first",
    preferLocalMac: true,
  });
}

export async function listNodes(
  opts: GatewayCallOptions,
  signal?: AbortSignal,
): Promise<NodeListNode[]> {
  // In-process calls share this build; every transported call replaces this from hello.
  let supportsContext = true;
  const res = await callGatewayTool(
    "node.list",
    opts,
    {},
    {
      signal,
      onHelloOk: (hello) => {
        supportsContext =
          hello.features.capabilities?.includes(SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY) === true;
      },
    },
  );
  // Older Gateways expose unknown node caps but strip the new field from system.run.
  const nodes = parseNodeList(res);
  if (!supportsContext) {
    // Only transport can lack support; these records were decoded for this RPC.
    for (const node of nodes) {
      node.caps = node.caps?.filter((cap) => cap !== SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY);
    }
  }
  return nodes;
}

export function resolveNodeIdFromList(
  nodes: NodeListNode[],
  query?: string,
  allowDefault = false,
  options: { allowCompactDisplayName?: boolean } = {},
): string {
  return resolveNodeIdFromNodeList(nodes, query, {
    allowDefault,
    allowCompactDisplayName: options.allowCompactDisplayName,
    pickDefaultNode,
  });
}

export async function resolveAgentNodeId(opts: GatewayCallOptions, query: string) {
  return (await resolveAgentNode(opts, query)).nodeId;
}

export async function resolveAgentNode(
  opts: GatewayCallOptions,
  query: string,
): Promise<NodeListNode> {
  return resolveNodeFromNodeList(await listNodes(opts), query);
}

export async function invokeAgentNodeCommand(params: {
  gatewayOpts: GatewayCallOptions;
  nodeId: string;
  command: string;
  commandParams: Record<string, unknown>;
  timeoutMs?: number;
  idempotencyKey?: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  const raw = await callGatewayTool<{ payload: unknown }>(
    "node.invoke",
    params.gatewayOpts,
    {
      nodeId: params.nodeId,
      command: params.command,
      params: params.commandParams,
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey ?? crypto.randomUUID(),
    },
    { signal: params.signal },
  );
  return raw && typeof raw === "object" && Object.hasOwn(raw, "payload") ? raw.payload : raw;
}
