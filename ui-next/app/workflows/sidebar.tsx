import React from "react";

const styles = {
  aside: {
    width: 280,
    background: "var(--bg)",
    borderLeft: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
  } as React.CSSProperties,
  header: {
    padding: "16px 20px",
    borderBottom: "1px solid var(--border)",
    fontWeight: 600,
    fontSize: 14,
    color: "var(--text-strong)",
  } as React.CSSProperties,
  content: {
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    gap: 24,
  } as React.CSSProperties,
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--muted)",
    marginBottom: 4,
  } as React.CSSProperties,
  item: {
    background: "var(--card)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    padding: "10px 14px",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    fontWeight: 500,
    color: "var(--text-strong)",
    cursor: "grab",
    display: "flex",
    alignItems: "center",
    gap: 12,
    transition: "box-shadow 0.2s, border-color 0.2s",
  } as React.CSSProperties,
  iconBox: {
    width: 28,
    height: 28,
    borderRadius: 6,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 14,
  } as React.CSSProperties,
  itemLabel: {
    display: "flex",
    flexDirection: "column",
  } as React.CSSProperties,
  itemSub: {
    fontSize: 11,
    color: "var(--muted)",
    fontWeight: 400,
  } as React.CSSProperties,
};

const NODES = {
  trigger: [
    {
      type: "trigger",
      label: "Schedule (Cron)",
      subline: "Run periodically",
      icon: "⏱️",
    },
    {
      type: "trigger",
      label: "Chat Message",
      subline: "On new chat event",
      icon: "💬",
      triggerType: "chat",
    },
  ],
  action: [
    {
      type: "action",
      label: "AI Agent Prompt",
      subline: "Ask an AI Agent",
      icon: "🧠",
      actionType: "agent-prompt",
    },
    {
      type: "action",
      label: "Execute Tool",
      subline: "Run a catalog tool",
      icon: "🛠️",
      actionType: "execute-tool",
    },
    {
      type: "action",
      label: "Send Message",
      subline: "Send via channel",
      icon: "📤",
      actionType: "send-message",
    },
    {
      type: "action",
      label: "Remote Invoke",
      subline: "Execute on a Node",
      icon: "💻",
      actionType: "remote-invoke",
    },
    {
      type: "action",
      label: "Speak (TTS)",
      subline: "Convert to audio",
      icon: "🗣️",
      actionType: "tts",
    },
  ],
  database: [
    {
      type: "action",
      label: "Supabase Select",
      subline: "Query data",
      icon: "🔍",
      actionType: "supabase-select",
    },
    {
      type: "action",
      label: "Supabase Insert",
      subline: "Insert row",
      icon: "➕",
      actionType: "supabase-insert",
    },
    {
      type: "action",
      label: "Supabase Update",
      subline: "Update rows",
      icon: "✏️",
      actionType: "supabase-update",
    },
    {
      type: "action",
      label: "Supabase Delete",
      subline: "Delete rows",
      icon: "🗑️",
      actionType: "supabase-delete",
    },
    {
      type: "action",
      label: "Supabase RPC",
      subline: "Call function",
      icon: "⚡",
      actionType: "supabase-rpc",
    },
  ],
  logic: [
    {
      type: "logic",
      label: "If / Else",
      subline: "Branch by condition",
      icon: "🔀",
      actionType: "if-else",
    },
    {
      type: "logic",
      label: "Delay",
      subline: "Wait a duration",
      icon: "⏳",
      actionType: "delay",
    },
    {
      type: "logic",
      label: "Custom JS",
      subline: "Transform data",
      icon: "📝",
      actionType: "custom-js",
    },
  ],
};

function DraggableItem({ item }: { item: Record<string, string | undefined> }) {
  const onDragStart = (event: React.DragEvent) => {
    event.dataTransfer.setData("application/reactflow/type", item.type as string);
    event.dataTransfer.setData(
      "application/reactflow/data",
      JSON.stringify({
        label: item.label,
        subline: item.subline,
        icon: item.icon,
        triggerType: item.triggerType,
        actionType: item.actionType,
      }),
    );
    event.dataTransfer.effectAllowed = "move";
  };

  const isTrigger = item.type === "trigger";
  const isLogic = item.type === "logic";

  let color = "#8b5cf6"; // Action
  let bg = "rgba(139, 92, 246, 0.1)";

  if (isTrigger) {
    color = "var(--ok)";
    bg = "var(--ok-subtle)";
  } else if (isLogic) {
    color = "#f59e0b";
    bg = "rgba(245, 158, 11, 0.1)";
  }

  return (
    <div
      style={styles.item}
      draggable
      onDragStart={onDragStart}
      onMouseOver={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = color;
      }}
      onMouseOut={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "var(--border)";
      }}
    >
      <div style={{ ...styles.iconBox, color, background: bg }}>{item.icon}</div>
      <div style={styles.itemLabel}>
        <span>{item.label}</span>
        <span style={styles.itemSub}>{item.subline}</span>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside style={styles.aside}>
      <div style={styles.header}>Node Palette</div>
      <div style={styles.content}>
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Triggers</div>
          {NODES.trigger.map((item) => (
            <DraggableItem key={item.label} item={item} />
          ))}
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>Actions</div>
          {NODES.action.map((item) => (
            <DraggableItem key={item.label} item={item} />
          ))}
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>Database</div>
          {NODES.database.map((item) => (
            <DraggableItem key={item.label} item={item} />
          ))}
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>Logic & Control</div>
          {NODES.logic.map((item) => (
            <DraggableItem key={item.label} item={item} />
          ))}
        </div>
      </div>
    </aside>
  );
}
