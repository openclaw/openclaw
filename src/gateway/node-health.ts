export type NodeHealthFrame = {
  /** Node-local timestamp (ms since epoch) if available; otherwise gateway receive time. */
  ts: number;
  /** Optional schema version for forward/backward compatibility. */
  v?: number;
  /** Opaque "kind" so we can add other frame shapes later (telemetry, alerts, etc.). */
  kind?: string;
  /**
   * Free-form payload (kept intentionally flexible).
   * Consumers should feature-detect fields rather than assuming a fixed shape.
   */
  data: Record<string, unknown>;
};

export type NodeHealthEntry = {
  nodeId: string;
  receivedAtMs: number;
  frame: NodeHealthFrame;
};

// In-memory latest-frame store per node. ("Persist" here means "retain in gateway memory".)
const latestByNode = new Map<string, NodeHealthEntry>();

export function upsertNodeHealthFrame(params: { nodeId: string; frame: NodeHealthFrame }) {
  const now = Date.now();
  const entry: NodeHealthEntry = {
    nodeId: params.nodeId,
    receivedAtMs: now,
    frame: {
      // Ensure ts is always present.
      ts: typeof params.frame.ts === "number" && Number.isFinite(params.frame.ts) ? params.frame.ts : now,
      v: params.frame.v,
      kind: params.frame.kind,
      data: typeof params.frame.data === "object" && params.frame.data !== null ? params.frame.data : {},
    },
  };
  latestByNode.set(params.nodeId, entry);
  return entry;
}

export function getLatestNodeHealthFrames(): NodeHealthEntry[] {
  return [...latestByNode.values()];
}

export function clearNodeHealthFramesForNode(nodeId: string) {
  latestByNode.delete(nodeId);
}
