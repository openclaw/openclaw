import type { AgentHierarchy, OrgChartNode, SidebarAgentEntry } from "@/types/agents";

type AgentConfigEntry = {
  id: string;
  name?: string;
  identity?: { emoji?: string };
  model?: string | { primary?: string };
  role?: string;
  department?: string;
  subagents?: { allowAgents?: string[] };
};

/** Fallback metadata for known Matrix agents when the gateway binary predates role/department support. */
export const KNOWN_AGENT_META: Record<string, { role: string; department: string }> = {
  main: { role: "CEO", department: "operations" },
  neo: { role: "CTO", department: "engineering" },
  morpheus: { role: "CMO", department: "marketing" },
  trinity: { role: "CFO", department: "finance" },
  tank: { role: "Backend Engineer", department: "engineering" },
  dozer: { role: "DevOps Engineer", department: "engineering" },
  mouse: { role: "Research Analyst", department: "engineering" },
  niobe: { role: "Content Strategist", department: "marketing" },
  switch: { role: "Creative Director", department: "marketing" },
  rex: { role: "PR & Communications", department: "marketing" },
  oracle: { role: "Data Analyst", department: "finance" },
  seraph: { role: "Security & Compliance", department: "finance" },
  zee: { role: "Financial Analyst", department: "finance" },
};

/**
 * Build a tree hierarchy from a flat config agents list.
 * Uses `subagents.allowAgents` to determine parent→child edges.
 */
export function buildAgentHierarchy(
  agentsList: AgentConfigEntry[],
  filesMap?: Map<string, Set<string>>,
): AgentHierarchy {
  if (!agentsList || agentsList.length === 0) {
    return { roots: [], nodeCount: 0 };
  }

  const lookup = new Map<string, AgentConfigEntry>();
  for (const agent of agentsList) {
    lookup.set(agent.id, agent);
  }

  // Collect all parent→child claims (a child may be claimed by multiple parents
  // when tier-2 agents share a talent pool of tier-3 workers).
  const childIds = new Set<string>();
  const parentsOf = new Map<string, string[]>(); // childId → [parentIds that claim it]

  for (const agent of agentsList) {
    const allowed = agent.subagents?.allowAgents;
    if (!Array.isArray(allowed)) {
      continue;
    }
    for (const childId of allowed) {
      if (childId === "*" || !lookup.has(childId)) {
        continue;
      }
      childIds.add(childId);
      const parents = parentsOf.get(childId) ?? [];
      parents.push(agent.id);
      parentsOf.set(childId, parents);
    }
  }

  // Round-robin distribute shared children across their parents so the org chart
  // shows an even spread instead of dumping all workers under the first parent.
  const childrenOf = new Map<string, string[]>();
  const parentCounters = new Map<string, number>(); // parentId → current child count

  // Sort children by config order for stable distribution
  const sharedChildren = [...parentsOf.entries()];
  for (const [childId, parents] of sharedChildren) {
    // Pick the parent with the fewest children so far
    let bestParent = parents[0];
    let bestCount = parentCounters.get(bestParent) ?? 0;
    for (let i = 1; i < parents.length; i++) {
      const count = parentCounters.get(parents[i]) ?? 0;
      if (count < bestCount) {
        bestParent = parents[i];
        bestCount = count;
      }
    }
    const existing = childrenOf.get(bestParent) ?? [];
    existing.push(childId);
    childrenOf.set(bestParent, existing);
    parentCounters.set(bestParent, bestCount + 1);
  }

  // Roots = agents not referenced as anyone's primary child
  const rootIds = agentsList.filter((a) => !childIds.has(a.id)).map((a) => a.id);

  // Build tree recursively with cycle prevention
  const visited = new Set<string>();
  let nodeCount = 0;

  function buildNode(agentId: string): OrgChartNode | null {
    if (visited.has(agentId)) {
      return null;
    }
    visited.add(agentId);

    const agent = lookup.get(agentId);
    if (!agent) {
      return null;
    }

    nodeCount++;
    const agentFiles = filesMap?.get(agentId);

    const children: OrgChartNode[] = [];
    for (const childId of childrenOf.get(agentId) ?? []) {
      const child = buildNode(childId);
      if (child) {
        children.push(child);
      }
    }

    const modelStr =
      typeof agent.model === "string"
        ? agent.model
        : typeof agent.model === "object" && agent.model?.primary
          ? agent.model.primary
          : undefined;

    const knownMeta = KNOWN_AGENT_META[agent.id];
    return {
      agentId: agent.id,
      name: agent.name || agent.id,
      emoji: agent.identity?.emoji,
      model: modelStr,
      role: agent.role ?? knownMeta?.role,
      department: agent.department ?? knownMeta?.department,
      hasSoul: agentFiles?.has("SOUL.md") ?? false,
      hasIdentity: agentFiles?.has("IDENTITY.md") ?? false,
      children,
    };
  }

  const roots: OrgChartNode[] = [];
  for (const rootId of rootIds) {
    const node = buildNode(rootId);
    if (node) {
      roots.push(node);
    }
  }

  return { roots, nodeCount };
}

/**
 * Flatten a hierarchy tree into a depth-first ordered list with depth info.
 * Used to render the sidebar in hierarchy order with indentation.
 */
export function flattenHierarchy(hierarchy: AgentHierarchy): SidebarAgentEntry[] {
  const result: SidebarAgentEntry[] = [];

  function walk(node: OrgChartNode, depth: number) {
    result.push({ agentId: node.agentId, depth });
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  }

  for (const root of hierarchy.roots) {
    walk(root, 0);
  }
  return result;
}
