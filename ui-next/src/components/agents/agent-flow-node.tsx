import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { CheckCircle2, Users, Pencil, Copy, UserPlus, Power, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

export interface AgentNodeData {
  agentId: string;
  name: string;
  role: string;
  tier: number;
  department: string;
  installed: boolean;
  requires: string | null;
  departmentColor: string;
  enabled?: boolean;
  bundled?: boolean;
  healthStatus?: "healthy" | "warning" | "error";
}

export type AgentFlowNode = Node<AgentNodeData, "agent">;

export interface AgentNodeActions {
  onPreview?: (agentId: string) => void;
  onEdit?: (agentId: string) => void;
  onClone?: (agentId: string) => void;
  onAddSpecialist?: (agentId: string, department: string) => void;
  onToggleEnabled?: (agentId: string, enabled: boolean) => void;
  onDelete?: (agentId: string) => void;
  onHealthClick?: (agentId: string) => void;
}

// Stored externally so the ReactFlow nodeTypes object stays stable
let _nodeActions: AgentNodeActions = {};
export function setNodeActions(actions: AgentNodeActions) {
  _nodeActions = actions;
}

const TIER_SIZES = {
  1: "min-w-[180px] px-4 py-3",
  2: "min-w-[160px] px-3 py-2.5",
  3: "min-w-[140px] px-3 py-2",
} as const;

const TIER_LABELS: Record<number, string> = {
  1: "Core",
  2: "Dept Head",
  3: "Specialist",
};

const HEALTH_COLORS: Record<string, string> = {
  healthy: "bg-green-500",
  warning: "bg-yellow-500",
  error: "bg-red-500",
};

function ActionBtn({
  icon: Icon,
  label,
  onClick,
  variant,
}: {
  icon: typeof Pencil;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  variant?: "danger";
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        "nopan nodrag size-5 flex items-center justify-center rounded transition-colors",
        variant === "danger"
          ? "hover:bg-red-500/20 hover:text-red-400 text-muted-foreground"
          : "hover:bg-white/10 text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3" />
    </button>
  );
}

export function AgentFlowNodeComponent({ data }: NodeProps<AgentFlowNode>) {
  const navigate = useNavigate();
  const sizeClass = TIER_SIZES[data.tier as keyof typeof TIER_SIZES] ?? TIER_SIZES[3];
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isDisabled = data.enabled === false;

  return (
    <div
      className={cn(
        // "group" enables group-hover on children; "nopan" enables pointer events on non-draggable nodes
        "group nopan rounded-lg border-2 bg-card shadow-md transition-all cursor-pointer",
        "hover:shadow-lg hover:scale-[1.02]",
        sizeClass,
        data.installed ? "border-opacity-100" : "border-dashed border-opacity-60",
        isDisabled && "opacity-40",
      )}
      style={{ borderColor: data.departmentColor }}
      onClick={() =>
        _nodeActions.onPreview
          ? _nodeActions.onPreview(data.agentId)
          : navigate(`/agents/preview/${data.agentId}`)
      }
      onMouseLeave={() => setConfirmDelete(false)}
    >
      {/* Top handle for incoming edges */}
      {data.tier > 1 && (
        <Handle
          type="target"
          position={Position.Top}
          className="!bg-transparent !border-0 !w-0 !h-0"
        />
      )}

      <div className="flex items-center gap-2">
        {/* Color dot */}
        <div
          className="size-2.5 rounded-full shrink-0"
          style={{ backgroundColor: data.departmentColor }}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn("font-semibold truncate", data.tier === 1 ? "text-sm" : "text-xs")}>
              {data.name}
            </span>
            {data.installed && <CheckCircle2 className="size-3 text-green-500 shrink-0" />}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground truncate">{data.role}</span>
          </div>
        </div>

        {/* Health indicator dot */}
        {data.healthStatus && _nodeActions.onHealthClick && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              _nodeActions.onHealthClick!(data.agentId);
            }}
            title={`Health: ${data.healthStatus}`}
            className="nopan nodrag shrink-0"
          >
            <div className={cn("size-2 rounded-full", HEALTH_COLORS[data.healthStatus])} />
          </button>
        )}
      </div>

      {/* Tier badge row */}
      <div className="flex items-center gap-1.5 mt-1.5">
        <span
          className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
          style={{
            backgroundColor: `${data.departmentColor}20`,
            color: data.departmentColor,
          }}
        >
          T{data.tier} {TIER_LABELS[data.tier] ?? "Agent"}
        </span>
        {data.tier === 2 && (
          <span className="text-[9px] text-muted-foreground flex items-center gap-0.5">
            <Users className="size-2.5" />
          </span>
        )}
      </div>

      {/* Action buttons — shown on hover via CSS group-hover */}
      <div className="hidden group-hover:flex items-center gap-0.5 mt-1.5 pt-1.5 border-t border-white/10">
        {_nodeActions.onEdit && (
          <ActionBtn
            icon={Pencil}
            label="Edit / Configure"
            onClick={(e) => {
              e.stopPropagation();
              _nodeActions.onEdit!(data.agentId);
            }}
          />
        )}
        {_nodeActions.onClone && (
          <ActionBtn
            icon={Copy}
            label="Clone agent"
            onClick={(e) => {
              e.stopPropagation();
              _nodeActions.onClone!(data.agentId);
            }}
          />
        )}
        {_nodeActions.onAddSpecialist && data.tier === 2 && (
          <ActionBtn
            icon={UserPlus}
            label="Add specialist"
            onClick={(e) => {
              e.stopPropagation();
              _nodeActions.onAddSpecialist!(data.agentId, data.department);
            }}
          />
        )}
        {_nodeActions.onToggleEnabled && data.tier > 1 && (
          <ActionBtn
            icon={Power}
            label={isDisabled ? "Enable" : "Disable"}
            onClick={(e) => {
              e.stopPropagation();
              _nodeActions.onToggleEnabled!(data.agentId, isDisabled);
            }}
          />
        )}
        {_nodeActions.onDelete && !data.bundled && data.tier > 1 && (
          <>
            {confirmDelete ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  _nodeActions.onDelete!(data.agentId);
                  setConfirmDelete(false);
                }}
                className="nopan nodrag text-[9px] font-medium text-red-400 hover:bg-red-500/20 rounded px-1.5 py-0.5"
                title="Confirm delete"
              >
                Confirm?
              </button>
            ) : (
              <ActionBtn
                icon={Trash2}
                label="Delete agent"
                variant="danger"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDelete(true);
                }}
              />
            )}
          </>
        )}
      </div>

      {/* Bottom handle for outgoing edges */}
      {data.tier < 3 && (
        <Handle
          type="source"
          position={Position.Bottom}
          className="!bg-transparent !border-0 !w-0 !h-0"
        />
      )}
    </div>
  );
}
