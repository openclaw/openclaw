import { resolveNodeIdFromCandidates } from "../../shared/node-match.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

export type NodeListNode = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  remoteIp?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  paired?: boolean;
  connected?: boolean;
};

type PendingRequest = {
  requestId: string;
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  remoteIp?: string;
  isRepair?: boolean;
  ts: number;
};

type PairedNode = {
  nodeId: string;
  token?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  remoteIp?: string;
  permissions?: Record<string, boolean>;
  createdAtMs?: number;
  approvedAtMs?: number;
};

type PairingList = {
  pending: PendingRequest[];
  paired: PairedNode[];
};

function parseNodeList(value: unknown): NodeListNode[] {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return Array.isArray(obj.nodes) ? (obj.nodes as NodeListNode[]) : [];
}

function parsePairingList(value: unknown): PairingList {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const pending = Array.isArray(obj.pending) ? (obj.pending as PendingRequest[]) : [];
  const paired = Array.isArray(obj.paired) ? (obj.paired as PairedNode[]) : [];
  return { pending, paired };
}

async function loadNodes(opts: GatewayCallOptions): Promise<NodeListNode[]> {
  try {
    const res = await callGatewayTool("node.list", opts, {});
    return parseNodeList(res);
  } catch {
    const res = await callGatewayTool("node.pair.list", opts, {});
    const { paired } = parsePairingList(res);
    return paired.map((n) => ({
      nodeId: n.nodeId,
      displayName: n.displayName,
      platform: n.platform,
      remoteIp: n.remoteIp,
    }));
  }
}

function pickDefaultNode(nodes: NodeListNode[]): NodeListNode | null {
  const withCanvas = nodes.filter((n) =>
    Array.isArray(n.caps) ? n.caps.includes("canvas") : true,
  );
  if (withCanvas.length === 0) {
    return null;
  }

  const connected = withCanvas.filter((n) => n.connected);
  const candidates = connected.length > 0 ? connected : withCanvas;
  if (candidates.length === 1) {
    return candidates[0];
  }

  const local = candidates.filter(
    (n) =>
      n.platform?.toLowerCase().startsWith("mac") &&
      typeof n.nodeId === "string" &&
      n.nodeId.startsWith("mac-"),
  );
  if (local.length === 1) {
    return local[0];
  }

  return null;
}

export async function listNodes(opts: GatewayCallOptions): Promise<NodeListNode[]> {
  return loadNodes(opts);
}

export function resolveNodeIdFromList(
  nodes: NodeListNode[],
  query?: string,
  allowDefault = false,
): string {
  const q = String(query ?? "").trim();
  if (!q) {
    if (allowDefault) {
      const picked = pickDefaultNode(nodes);
      if (picked) {
        return picked.nodeId;
      }
    }
    throw new Error("node required");
  }
  return resolveNodeIdFromCandidates(nodes, q);
}

export async function resolveNodeId(
  opts: GatewayCallOptions,
  query?: string,
  allowDefault = false,
) {
  const nodes = await loadNodes(opts);
  return resolveNodeIdFromList(nodes, query, allowDefault);
}
