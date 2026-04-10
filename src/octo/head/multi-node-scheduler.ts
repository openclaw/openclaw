// Octopus Orchestrator -- MultiNodeScheduler (M4-07)
//
// Extends scheduling to consider arms across connected nodes. Tracks
// per-node capacity from telemetry data and routes grips to the best
// available node based on capabilities, locality, and load.
//
// Context docs:
//   - LLD.md section Scheduler Algorithm -- scoring function and hard filters
//   - scheduler.ts (M3-03/M4-03) -- single-node scheduler
//
// Boundary discipline (OCTO-DEC-033):
//   Only `node:*` builtins and relative imports inside `src/octo/` are
//   permitted. No external dependencies.

import type { SchedulerService } from "./scheduler.ts";

// ──────────────────────────────────────────────────────────────────────────
// NodeInfo -- per-node capacity and capability snapshot
// ──────────────────────────────────────────────────────────────────────────

export interface NodeInfo {
  nodeId: string;
  capabilities: string[];
  activeArms: number;
  maxArms: number;
  connected: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// MultiNodeScheduler
// ──────────────────────────────────────────────────────────────────────────

export class MultiNodeScheduler {
  private readonly scheduler: SchedulerService;
  private readonly nodes: Map<string, NodeInfo>;

  constructor(scheduler: SchedulerService, nodes: Map<string, NodeInfo>) {
    this.scheduler = scheduler;
    this.nodes = nodes;
  }

  /**
   * Update (or insert) node info from telemetry. Merges partial updates
   * with existing data if the node is already tracked.
   */
  updateNodeInfo(nodeId: string, info: Partial<NodeInfo>): void {
    const existing = this.nodes.get(nodeId);
    if (existing) {
      this.nodes.set(nodeId, { ...existing, ...info, nodeId });
    } else {
      this.nodes.set(nodeId, {
        nodeId,
        capabilities: info.capabilities ?? [],
        activeArms: info.activeArms ?? 0,
        maxArms: info.maxArms ?? 0,
        connected: info.connected ?? false,
      });
    }
  }

  /**
   * Remove a node from tracking (e.g. on permanent disconnect).
   */
  removeNode(nodeId: string): void {
    this.nodes.delete(nodeId);
  }

  /**
   * Return all nodes that are connected, have spare capacity, and
   * possess every required capability. When no capabilities are
   * required, any connected node with capacity qualifies.
   */
  getAvailableNodes(requiredCapabilities?: string[]): NodeInfo[] {
    const result: NodeInfo[] = [];
    for (const node of this.nodes.values()) {
      if (!node.connected) {
        continue;
      }
      if (node.activeArms >= node.maxArms) {
        continue;
      }
      if (requiredCapabilities && requiredCapabilities.length > 0) {
        const hasAll = requiredCapabilities.every((cap) => node.capabilities.includes(cap));
        if (!hasAll) {
          continue;
        }
      }
      result.push(node);
    }
    return result;
  }

  /**
   * Select the best node for a grip requiring the given capabilities.
   *
   * Algorithm:
   *   1. Filter by capabilities (hard filter).
   *   2. Prefer local node (nodeId === "local") -- least hops.
   *   3. Break ties by load: lowest activeArms / maxArms ratio wins.
   *
   * Returns null when no capable, connected node with capacity exists.
   */
  selectBestNode(requiredCapabilities: string[]): NodeInfo | null {
    const available = this.getAvailableNodes(requiredCapabilities);
    if (available.length === 0) {
      return null;
    }

    // Sort: local first, then by ascending load fraction.
    available.sort((a, b) => {
      const aLocal = a.nodeId === "local" ? 0 : 1;
      const bLocal = b.nodeId === "local" ? 0 : 1;
      if (aLocal !== bLocal) {
        return aLocal - bLocal;
      }

      const aLoad = a.maxArms > 0 ? a.activeArms / a.maxArms : 1;
      const bLoad = b.maxArms > 0 ? b.activeArms / b.maxArms : 1;
      return aLoad - bLoad;
    });

    return available[0];
  }
}
