import type { Node, Edge } from "@xyflow/react";
import dagre from "dagre";
import type { AgentNodeData } from "@/components/agents/agent-flow-node";
import type { DepartmentEdgeData } from "@/components/agents/department-edge";
import { DEPARTMENT_COLORS } from "@/lib/matrix-tier-map";

interface MarketplaceAgent {
  id: string;
  name: string;
  tier: number;
  role: string;
  department: string;
  installStatus: string;
  requires?: string | null;
  enabled?: boolean;
  bundled?: boolean;
  healthStatus?: "healthy" | "warning" | "error";
}

// Node dimensions by tier for dagre layout
const NODE_DIMENSIONS: Record<number, { width: number; height: number }> = {
  1: { width: 200, height: 80 },
  2: { width: 180, height: 72 },
  3: { width: 160, height: 64 },
};

function getDeptColor(department: string): string {
  return DEPARTMENT_COLORS[department] ?? "#64748b";
}

/**
 * Build React Flow nodes and edges from marketplace agents.
 * Uses dagre for automatic top-to-bottom tree layout.
 */
export function buildOrgGraph(agents: MarketplaceAgent[]): {
  nodes: Node<AgentNodeData>[];
  edges: Edge<DepartmentEdgeData>[];
} {
  if (agents.length === 0) {
    return { nodes: [], edges: [] };
  }

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  // Build edges from `requires` relationships + implicit COO→T2
  const edges: Edge<DepartmentEdgeData>[] = [];
  const coo = agents.find((a) => a.tier === 1);
  const cooId = coo?.id ?? "operator1";

  for (const agent of agents) {
    if (agent.tier === 2 && coo) {
      // Department heads connect to COO
      edges.push({
        id: `${cooId}-${agent.id}`,
        source: cooId,
        target: agent.id,
        type: "department",
        data: { departmentColor: getDeptColor(agent.department) },
      });
    } else if (agent.requires && agentMap.has(agent.requires)) {
      // Specialists connect to their parent via `requires`
      edges.push({
        id: `${agent.requires}-${agent.id}`,
        source: agent.requires,
        target: agent.id,
        type: "department",
        data: { departmentColor: getDeptColor(agent.department) },
      });
    }
  }

  // Dagre layout
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "TB",
    nodesep: 40,
    ranksep: 60,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const agent of agents) {
    const dim = NODE_DIMENSIONS[agent.tier] ?? NODE_DIMENSIONS[3];
    g.setNode(agent.id, { width: dim.width, height: dim.height });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  // Build nodes with dagre-computed positions
  const nodes: Node<AgentNodeData>[] = agents.map((agent) => {
    const pos = g.node(agent.id);
    const dim = NODE_DIMENSIONS[agent.tier] ?? NODE_DIMENSIONS[3];
    return {
      id: agent.id,
      type: "agent",
      position: {
        x: (pos?.x ?? 0) - dim.width / 2,
        y: (pos?.y ?? 0) - dim.height / 2,
      },
      data: {
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        tier: agent.tier,
        department: agent.department,
        installed: agent.installStatus.startsWith("installed"),
        requires: agent.requires ?? null,
        departmentColor: getDeptColor(agent.department),
        enabled: agent.enabled,
        bundled: agent.bundled,
        healthStatus: agent.healthStatus,
      },
    };
  });

  return { nodes, edges };
}
