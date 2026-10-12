import type { NodeHostStatsPayload } from "../../packages/gateway-protocol/src/schema/nodes.js";
import type { NodeHostStats } from "../shared/node-host-stats.js";
import type { NodeSession } from "./node-session.types.js";

export type NodeCommandFeaturesUpdate = {
  nodeId: string;
  connId?: string;
  features: Record<string, string[]>;
};

export type NodeHostStatsUpdate = {
  nodeId: string;
  connId?: string;
  stats: NodeHostStatsPayload;
  observedAtMs?: number;
};

/** Connection-owned facts never widen approval or publish active-node prompt context. */
export function updateNodeCommandFeatures(
  node: NodeSession | undefined,
  params: NodeCommandFeaturesUpdate,
): Record<string, string[]> | null {
  if (!node || node.connId !== params.connId) {
    return null;
  }
  node.commandFeatures = Object.fromEntries(
    Object.entries(params.features)
      .filter(([command]) => node.declaredCommands.includes(command))
      .map(([command, features]) => [command, [...new Set(features)].toSorted()]),
  );
  return node.commandFeatures;
}

export function updateNodeHostStats(
  node: NodeSession | undefined,
  params: NodeHostStatsUpdate,
): NodeHostStats | null {
  if (!node || node.connId !== params.connId) {
    return null;
  }
  node.hostStats = { ...params.stats, updatedAtMs: params.observedAtMs ?? Date.now() };
  return node.hostStats;
}
