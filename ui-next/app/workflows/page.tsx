"use client";

import WorkflowEditor from "./workflow-editor";

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    animation: "rise 0.3s ease-out",
  } as React.CSSProperties,
  header: {
    marginBottom: 24,
  } as React.CSSProperties,
  title: {
    fontSize: 22,
    fontWeight: 600,
    letterSpacing: "-0.025em",
    color: "var(--text-strong)",
    margin: 0,
  } as React.CSSProperties,
  sub: {
    color: "var(--muted)",
    marginTop: 6,
    marginBottom: 0,
  } as React.CSSProperties,
  editorContainer: {
    flex: 1,
    minHeight: 600,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-lg)",
    background: "var(--card)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  } as React.CSSProperties,
};

export default function WorkflowsPage() {
  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>Workflows</h1>
        <p style={styles.sub}>
          Build powerful automations visually using a node-based editor similar to n8n.
        </p>
      </div>

      <div style={styles.editorContainer}>
        <WorkflowEditor />
      </div>
    </div>
  );
}
