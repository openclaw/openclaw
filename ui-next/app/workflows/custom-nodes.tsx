import { Handle, Position } from "@xyflow/react";

const styles = {
  node: {
    padding: "12px 16px",
    borderRadius: "var(--radius-md)",
    minWidth: 200,
    background: "var(--card)",
    color: "var(--text-strong)",
    border: "1px solid var(--border)",
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
    border: "2px solid var(--card)",
  },
};

export interface NodeData extends Record<string, unknown> {
  label: string;
  subline?: string;
  icon?: string;
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
  return (
    <div
      style={{
        ...styles.node,
        borderColor: "#f59e0b",
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
      <Handle type="source" position={Position.Right} style={styles.handle} isConnectable={true} />
    </div>
  );
}
