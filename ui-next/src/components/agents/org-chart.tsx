import { ChevronRight, ChevronDown, Network } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentHierarchy, OrgChartNode } from "@/types/agents";
import { OrgChartNodeCard } from "./org-chart-node";

function TreeBranch({
  node,
  selectedAgentId,
  onSelect,
  onEdit,
  depth,
}: {
  node: OrgChartNode;
  selectedAgentId: string | null;
  onSelect: (agentId: string) => void;
  onEdit: (agentId: string) => void;
  depth: number;
}) {
  return (
    <div className="flex flex-col">
      <OrgChartNodeCard
        node={node}
        selectedAgentId={selectedAgentId}
        onSelect={onSelect}
        onEdit={onEdit}
      />

      {node.children.length > 0 && (
        <div className="ml-4 mt-1 flex flex-col gap-1 border-l border-border/60 pl-3">
          {node.children.map((child) => (
            <TreeBranch
              key={child.agentId}
              node={child}
              selectedAgentId={selectedAgentId}
              onSelect={onSelect}
              onEdit={onEdit}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function OrgChart({
  hierarchy,
  selectedAgentId,
  onSelect,
  onEdit,
}: {
  hierarchy: AgentHierarchy;
  selectedAgentId: string | null;
  onSelect: (agentId: string) => void;
  onEdit: (agentId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // Hide when there's only a single agent
  if (hierarchy.nodeCount <= 1) {
    return null;
  }

  return (
    <div className="rounded-lg border bg-card">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
          <Network className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Agent Hierarchy</span>
        </div>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
          {hierarchy.nodeCount} agents
        </Badge>
      </button>

      {!collapsed && (
        <div className={cn("border-t px-4 py-3 overflow-auto max-h-[320px]")}>
          <div className="flex flex-col gap-1">
            {hierarchy.roots.map((root) => (
              <TreeBranch
                key={root.agentId}
                node={root}
                selectedAgentId={selectedAgentId}
                onSelect={onSelect}
                onEdit={onEdit}
                depth={0}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
