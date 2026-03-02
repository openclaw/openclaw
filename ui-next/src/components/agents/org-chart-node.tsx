import { Box, CheckCircle2, AlertTriangle, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OrgChartNode } from "@/types/agents";

export function OrgChartNodeCard({
  node,
  selectedAgentId,
  onSelect,
  onEdit,
}: {
  node: OrgChartNode;
  selectedAgentId: string | null;
  onSelect: (agentId: string) => void;
  onEdit: (agentId: string) => void;
}) {
  const isSelected = selectedAgentId === node.agentId;

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-all group/node",
        isSelected
          ? "border-primary bg-primary/5 ring-1 ring-primary/30"
          : "border-border bg-card hover:bg-muted/50",
      )}
    >
      {/* Clickable area: selects agent */}
      <button
        onClick={() => onSelect(node.agentId)}
        className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
      >
        {/* Avatar */}
        <div
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full border shrink-0",
            isSelected ? "bg-primary/10 border-primary/30" : "bg-background",
          )}
        >
          {node.emoji ? (
            <span className="text-sm">{node.emoji}</span>
          ) : (
            <Box className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium truncate">{node.name}</span>
            {node.role && (
              <span className="text-[10px] font-medium text-primary/80 bg-primary/10 rounded px-1.5 py-0.5 shrink-0">
                {node.role}
              </span>
            )}
            <span title={node.hasSoul ? "SOUL.md exists" : "SOUL.md missing"}>
              {node.hasSoul ? (
                <CheckCircle2 className="h-3 w-3 text-primary shrink-0" />
              ) : (
                <AlertTriangle className="h-3 w-3 text-chart-5 shrink-0" />
              )}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {node.model && (
              <span className="text-[10px] font-mono text-muted-foreground truncate">
                {node.model}
              </span>
            )}
            {node.department && (
              <span className="text-[10px] text-muted-foreground/70 truncate">
                {node.department}
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Edit icon — opens Persona tab for this agent */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onEdit(node.agentId);
        }}
        className="shrink-0 rounded p-1 opacity-0 group-hover/node:opacity-100 hover:bg-muted transition-opacity"
        title="Edit persona"
      >
        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    </div>
  );
}
