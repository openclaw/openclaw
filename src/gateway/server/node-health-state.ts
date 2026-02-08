import type { NodeRegistry } from "../node-registry.js";

export type NodeHealthNode = {
  nodeId: string;
  connected: boolean;
  connectedAtMs?: number;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  caps?: string[];
  commands?: string[];
};

export type NodeHealthFrame = {
  ts: number;
  nodes: NodeHealthNode[];
};

let nodeHealthCache: NodeHealthFrame | null = null;
let nodeHealthRefresh: Promise<NodeHealthFrame> | null = null;
let broadcastNodeHealthUpdate: ((frame: NodeHealthFrame) => void) | null = null;

export function getNodeHealthCache(): NodeHealthFrame | null {
  return nodeHealthCache;
}

export function setBroadcastNodeHealthUpdate(fn: ((frame: NodeHealthFrame) => void) | null) {
  broadcastNodeHealthUpdate = fn;
}

export async function refreshNodeHealthSnapshot(params: {
  nodeRegistry: NodeRegistry;
}): Promise<NodeHealthFrame> {
  if (!nodeHealthRefresh) {
    nodeHealthRefresh = (async () => {
      const ts = Date.now();
      const nodes = params.nodeRegistry.listConnected().map((n) => ({
        nodeId: n.nodeId,
        connected: true,
        connectedAtMs: n.connectedAtMs,
        displayName: n.displayName,
        platform: n.platform,
        version: n.version,
        coreVersion: n.coreVersion,
        uiVersion: n.uiVersion,
        deviceFamily: n.deviceFamily,
        modelIdentifier: n.modelIdentifier,
        remoteIp: n.remoteIp,
        caps: n.caps,
        commands: n.commands,
      } satisfies NodeHealthNode));
      const frame: NodeHealthFrame = { ts, nodes };
      nodeHealthCache = frame;
      if (broadcastNodeHealthUpdate) {
        broadcastNodeHealthUpdate(frame);
      }
      return frame;
    })().finally(() => {
      nodeHealthRefresh = null;
    });
  }
  return nodeHealthRefresh;
}
