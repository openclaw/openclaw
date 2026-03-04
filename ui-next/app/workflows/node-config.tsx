import { Node } from "@xyflow/react";
import { NodeData } from "./custom-nodes";

const styles = {
  panel: {
    width: 320,
    background: "var(--bg)",
    borderLeft: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    animation: "slideInRight 0.2s ease-out",
  } as React.CSSProperties,
  header: {
    padding: "16px 20px",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  } as React.CSSProperties,
  title: {
    fontWeight: 600,
    fontSize: 14,
    color: "var(--text-strong)",
    display: "flex",
    alignItems: "center",
    gap: 8,
  } as React.CSSProperties,
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "var(--muted)",
    cursor: "pointer",
    fontSize: 16,
    padding: 4,
  } as React.CSSProperties,
  content: {
    padding: 20,
    display: "flex",
    flexDirection: "column",
    gap: 20,
  } as React.CSSProperties,
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  } as React.CSSProperties,
  label: {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--muted)",
  } as React.CSSProperties,
  input: {
    height: 36,
    padding: "0 12px",
    fontSize: 13,
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--card)",
    color: "var(--text-strong)",
    outline: "none",
  } as React.CSSProperties,
  textarea: {
    padding: "12px",
    fontSize: 13,
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--card)",
    color: "var(--text-strong)",
    outline: "none",
    minHeight: 80,
    resize: "vertical",
  } as React.CSSProperties,
  select: {
    height: 36,
    padding: "0 12px",
    fontSize: 13,
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--card)",
    color: "var(--text-strong)",
    outline: "none",
  } as React.CSSProperties,
};

interface NodeConfigPanelProps {
  node: Node | null;
  onClose: () => void;
  onUpdateData: (nodeId: string, newData: NodeData) => void;
}

export function NodeConfigPanel({ node, onClose, onUpdateData }: NodeConfigPanelProps) {
  if (!node) {
    return null;
  }

  const data: NodeData = (node.data as NodeData) || { label: "Node" };

  const handleChange = (key: string, value: string) => {
    onUpdateData(node.id, { ...data, [key]: value });
  };

  return (
    <aside style={styles.panel}>
      <div style={styles.header}>
        <div style={styles.title}>
          <span>{data.icon}</span>
          <span>{data.label || "Node Settings"}</span>
        </div>
        <button style={styles.closeBtn} onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div style={styles.content}>
        {/* Common Field */}
        <div style={styles.field}>
          <span style={styles.label}>Node Label</span>
          <input
            style={styles.input}
            value={data.label || ""}
            onChange={(e) => handleChange("label", e.target.value)}
          />
        </div>
        <div style={styles.field}>
          <span style={styles.label}>Description</span>
          <input
            style={styles.input}
            value={data.subline || ""}
            onChange={(e) => handleChange("subline", e.target.value)}
          />
        </div>

        {/* Dynamic Fields based on Label (Mock) */}
        {data.label === "Schedule (Cron)" && (
          <div style={styles.field}>
            <span style={styles.label}>Cron Expression</span>
            <input
              style={styles.input}
              placeholder="* * * * *"
              value={(data.cronExpr as string) || ""}
              onChange={(e) => handleChange("cronExpr", e.target.value)}
            />
          </div>
        )}

        {data.label === "Chat Message" && (
          <>
            <div style={styles.field}>
              <span style={styles.label}>Target Session Key</span>
              <input
                style={styles.input}
                placeholder="e.g. agent:main"
                value={(data.targetSessionKey as string) || ""}
                onChange={(e) => handleChange("targetSessionKey", e.target.value)}
              />
            </div>
            <div style={styles.field}>
              <span style={styles.label}>Match Keyword (Optional)</span>
              <input
                style={styles.input}
                placeholder="Trigger only if contains this word"
                value={(data.matchKeyword as string) || ""}
                onChange={(e) => handleChange("matchKeyword", e.target.value)}
              />
            </div>
          </>
        )}

        {data.label === "AI Agent Prompt" && (
          <>
            <div style={styles.field}>
              <span style={styles.label}>Agent ID (Optional)</span>
              <input
                style={styles.input}
                placeholder="Leave blank for default"
                value={(data.agentId as string) || ""}
                onChange={(e) => handleChange("agentId", e.target.value)}
              />
            </div>
            <div style={styles.field}>
              <span style={styles.label}>Prompt Template</span>
              <textarea
                style={styles.textarea}
                placeholder="Analyze the following data: {{input}}"
                value={(data.prompt as string) || ""}
                onChange={(e) => handleChange("prompt", e.target.value)}
              />
            </div>
          </>
        )}

        {data.label === "Send Message" && (
          <div style={styles.field}>
            <span style={styles.label}>Message Body</span>
            <textarea
              style={styles.textarea}
              placeholder="Hello world!"
              value={(data.body as string) || ""}
              onChange={(e) => handleChange("body", e.target.value)}
            />
          </div>
        )}
      </div>
    </aside>
  );
}
