import { Handle, Position } from "@xyflow/react";

const styles = {
  node: {
    padding: "12px 16px",
    borderRadius: "var(--radius-md)",
    minWidth: 200,
    background: "var(--card)",
    color: "var(--text-strong)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    display: "flex",
    alignItems: "center",
    gap: 12,
    boxShadow: "0 2px 6px rgba(0,0,0,0.05)",
  },
  iconBox: {
    width: 32,
    height: 32,
    borderRadius: 6,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 16,
    flexShrink: 0,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    lineHeight: 1.2,
  },
  sub: {
    fontSize: 11,
    color: "var(--muted)",
    marginTop: 2,
    lineHeight: 1.2,
  },
  handle: {
    width: 8,
    height: 8,
    background: "var(--muted)",
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "var(--card)",
  },
};

export interface NodeData extends Record<string, unknown> {
  label: string;
  subline?: string;
  icon?: string;
  
  // Trigger node fields
  cronExpr?: string;
  targetSessionKey?: string;
  matchKeyword?: string;
  
  // Session configuration (for trigger nodes)
  sessionTarget?: 'isolated' | 'reuse' | 'main';
  contextMode?: 'minimal' | 'full' | 'custom';
  modelOverride?: string;
  maxTokens?: number | string;
  thinking?: 'on' | 'off';
  
  // Action node fields
  agentId?: string;
  prompt?: string;
  outputSchema?: string; // ✅ NEW: JSON Schema string for AI Agent Prompt
  body?: string;
  channel?: string;
  recipientId?: string;
  accountId?: string;
  condition?: string;
  trueLabel?: string;
  falseLabel?: string;
  toolName?: string;
  toolArgs?: string;
  targetNodeId?: string;
  command?: string;
  params?: string;
  ttsText?: string;
  ttsProvider?: string;
  durationMs?: string;
  jsCode?: string;
  
  // Supabase fields
  supabaseInstance?: string;
  table?: string;
  columns?: string;
  filters?: string; // JSON string
  limit?: number | string;
  orderBy?: string;
  row?: string; // JSON string
  updates?: string; // JSON string
  function?: string;
  paramsStr?: string; // JSON string (renamed to avoid conflict with command params)
}

export function TriggerNode({ data }: { data: NodeData }) {
  return (
    <div
      style={{
        ...styles.node,
        borderColor: "var(--ok)",
      }}
    >
      <div
        style={{
          ...styles.iconBox,
          background: "var(--ok-subtle)",
          color: "var(--ok)",
        }}
      >
        <span>{data.icon || "⚡"}</span>
      </div>
      <div>
        <div style={styles.label}>{data.label}</div>
        {data.subline && <div style={styles.sub}>{data.subline}</div>}
      </div>
      <Handle type="source" position={Position.Right} style={styles.handle} isConnectable={true} />
    </div>
  );
}

export function ActionNode({ data }: { data: NodeData }) {
  return (
    <div
      style={{
        ...styles.node,
        borderColor: "#8b5cf6",
      }}
    >
      <Handle type="target" position={Position.Left} style={styles.handle} isConnectable={true} />
      <div
        style={{
          ...styles.iconBox,
          background: "rgba(139, 92, 246, 0.1)",
          color: "#8b5cf6",
        }}
      >
        <span>{data.icon || "🛠️"}</span>
      </div>
      <div>
        <div style={styles.label}>{data.label}</div>
        {data.subline && <div style={styles.sub}>{data.subline}</div>}
      </div>
      <Handle type="source" position={Position.Right} style={styles.handle} isConnectable={true} />
    </div>
  );
}

export function LogicNode({ data }: { data: NodeData }) {
  const isIfElse = data.label === "If / Else";

  return (
    <div
      style={{
        ...styles.node,
        borderColor: "#f59e0b",
        position: "relative",
      }}
    >
      <Handle type="target" position={Position.Left} style={styles.handle} isConnectable={true} />
      <div
        style={{
          ...styles.iconBox,
          background: "rgba(245, 158, 11, 0.1)",
          color: "#f59e0b",
        }}
      >
        <span>{data.icon || "🔀"}</span>
      </div>
      <div>
        <div style={styles.label}>{data.label}</div>
        {data.subline && <div style={styles.sub}>{data.subline}</div>}
      </div>

      {/* If/Else has two output handles: TRUE (top-right) and FALSE (bottom-right) */}
      {isIfElse ? (
        <>
          {/* TRUE branch handle - top right */}
          <Handle
            type="source"
            position={Position.Right}
            id="true"
            style={{
              ...styles.handle,
              top: "25%",
              background: "var(--ok)",
            }}
            isConnectable={true}
          />
          {/* FALSE branch handle - bottom right */}
          <Handle
            type="source"
            position={Position.Right}
            id="false"
            style={{
              ...styles.handle,
              top: "75%",
              background: "var(--danger)",
            }}
            isConnectable={true}
          />
          {/* Labels for handles */}
          <div
            style={{
              position: "absolute",
              right: "-35px",
              top: "20%",
              fontSize: 9,
              fontWeight: 600,
              color: "var(--ok)",
            }}
          >
            TRUE
          </div>
          <div
            style={{
              position: "absolute",
              right: "-40px",
              top: "70%",
              fontSize: 9,
              fontWeight: 600,
              color: "var(--danger)",
            }}
          >
            FALSE
          </div>
        </>
      ) : (
        // Regular logic nodes have single output
        <Handle
          type="source"
          position={Position.Right}
          style={styles.handle}
          isConnectable={true}
        />
      )}
    </div>
  );
}
