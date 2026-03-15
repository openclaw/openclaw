"use client";

import { useState, useEffect } from "react";

// ============================================
// Types
// ============================================

type SpecPanelData = {
  sessionId: string;
  featureName: string;
  specGenerated: boolean;
  designGenerated: boolean;
  tasksGenerated: boolean;
  progress: {
    completed: number;
    total: number;
    percent: number;
  };
  tasks: Array<{
    number: string;
    name: string;
    status: "pending" | "processing" | "completed";
    phase: string;
  }>;
  files: {
    spec?: string;
    design?: string;
    tasks?: string;
  };
};

// ============================================
// Styles
// ============================================

const styles = {
  panel: {
    width: 380,
    background: "var(--card)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: 16,
    display: "flex",
    flexDirection: "column" as const,
    gap: 16,
    overflow: "auto",
  } as React.CSSProperties,
  header: {
    paddingBottom: 12,
    borderBottom: "1px solid var(--border)",
  } as React.CSSProperties,
  title: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text-strong)",
    margin: "0 0 4px 0",
  } as React.CSSProperties,
  subtitle: {
    fontSize: 11,
    color: "var(--muted)",
    margin: 0,
  } as React.CSSProperties,
  fileStatus: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
    padding: 12,
    background: "var(--bg)",
    borderRadius: "var(--radius-md)",
  } as React.CSSProperties,
  fileItem: (active: boolean) => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderRadius: "var(--radius-sm)",
    background: active ? "var(--accent-subtle)" : "transparent",
    border: active ? "1px solid var(--accent)" : "1px solid transparent",
    cursor: "pointer",
    transition: "all 0.15s",
  } as React.CSSProperties),
  fileIcon: {
    fontSize: 14,
  } as React.CSSProperties,
  fileName: {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--text)",
  } as React.CSSProperties,
  fileBadge: (status: "pending" | "ready") => ({
    fontSize: 9,
    padding: "2px 6px",
    borderRadius: "var(--radius-sm)",
    background: status === "ready" ? "var(--ok-subtle)" : "var(--secondary)",
    color: status === "ready" ? "var(--ok)" : "var(--muted)",
    fontWeight: 600,
    marginLeft: "auto",
  } as React.CSSProperties),
  progressSection: {
    padding: 12,
    background: "var(--bg)",
    borderRadius: "var(--radius-md)",
  } as React.CSSProperties,
  progressBar: {
    width: "100%",
    height: 8,
    background: "var(--secondary)",
    borderRadius: "var(--radius-sm)",
    overflow: "hidden",
    marginTop: 8,
  } as React.CSSProperties,
  progressFill: (percent: number) => ({
    height: "100%",
    width: `${percent}%`,
    background: percent === 100 ? "var(--ok)" : "var(--accent)",
    transition: "width 0.3s",
  } as React.CSSProperties),
  progressText: {
    fontSize: 11,
    color: "var(--muted)",
    marginTop: 4,
  } as React.CSSProperties,
  tasksList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
    maxHeight: 300,
    overflow: "auto",
  } as React.CSSProperties,
  taskItem: (status: string) => ({
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "8px 10px",
    borderRadius: "var(--radius-sm)",
    background: status === "completed" ? "var(--ok-subtle)" : 
                status === "processing" ? "var(--accent-subtle)" : "transparent",
    border: "1px solid " + (status === "completed" ? "var(--ok)" : 
                            status === "processing" ? "var(--accent)" : "var(--border)"),
  } as React.CSSProperties),
  taskCheckbox: (status: string) => ({
    width: 14,
    height: 14,
    borderRadius: "var(--radius-sm)",
    background: status === "completed" ? "var(--ok)" : 
                status === "processing" ? "var(--accent)" : "var(--secondary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 10,
    color: "#fff",
    fontWeight: 700,
    flexShrink: 0,
    marginTop: 2,
  } as React.CSSProperties),
  taskContent: {
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  taskNumber: {
    fontSize: 9,
    color: "var(--muted)",
    fontWeight: 600,
  } as React.CSSProperties,
  taskName: {
    fontSize: 11,
    color: "var(--text)",
    marginTop: 2,
  } as React.CSSProperties,
  taskPhase: {
    fontSize: 9,
    color: "var(--muted)",
    marginTop: 4,
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: 8,
    paddingTop: 12,
    borderTop: "1px solid var(--border)",
  } as React.CSSProperties,
  btn: {
    flex: 1,
    height: 32,
    padding: "0 12px",
    fontSize: 11,
    fontWeight: 500,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--secondary)",
    color: "var(--text)",
    cursor: "pointer",
    transition: "all 0.15s",
  } as React.CSSProperties,
  btnPrimary: {
    background: "var(--accent)",
    borderColor: "var(--accent)",
    color: "#fff",
  } as React.CSSProperties,
  emptyState: {
    padding: 32,
    textAlign: "center" as const,
    color: "var(--muted)",
    fontSize: 12,
  } as React.CSSProperties,
};

// ============================================
// Component
// ============================================

export function SpecPanel() {
  const [data, setData] = useState<SpecPanelData | null>(null);
  const [activeTab, setActiveTab] = useState<"spec" | "design" | "tasks">("tasks");
  const [loading, setLoading] = useState(false);

  // Poll for session data
  useEffect(() => {
    const fetchData = async () => {
      try {
        // In real implementation, fetch from gateway
        // For now, mock data
        const mockData: SpecPanelData = {
          sessionId: "spec-1773548400",
          featureName: "build-a-login",
          specGenerated: true,
          designGenerated: true,
          tasksGenerated: true,
          progress: {
            completed: 5,
            total: 12,
            percent: 42,
          },
          tasks: [
            { number: "1.1", name: "Install dependencies", status: "completed", phase: "Setup" },
            { number: "1.2", name: "Initialize Prisma", status: "completed", phase: "Setup" },
            { number: "1.3", name: "Configure environment", status: "processing", phase: "Setup" },
            { number: "2.1", name: "Define User model", status: "pending", phase: "Database" },
            { number: "2.2", name: "Create migration", status: "pending", phase: "Database" },
          ],
          files: {},
        };
        setData(mockData);
      } catch (error) {
        console.error("Failed to fetch spec panel data:", error);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5000); // Poll every 5s
    return () => clearInterval(interval);
  }, []);

  if (!data) {
    return (
      <div style={styles.panel}>
        <div style={styles.emptyState}>
          Loading session data...
        </div>
      </div>
    );
  }

  if (!data.tasksGenerated && !data.specGenerated && !data.designGenerated) {
    return (
      <div style={styles.panel}>
        <div style={styles.header}>
          <h3 style={styles.title}>📋 Spec-First Session</h3>
          <p style={styles.subtitle}>{data.sessionId}</p>
        </div>
        <div style={styles.emptyState}>
          No files generated yet.
          <br />
          Start with <code>/spec clarify</code>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.header}>
        <h3 style={styles.title}>📋 Spec-First Session</h3>
        <p style={styles.subtitle}>
          {data.featureName} • {data.sessionId}
        </p>
      </div>

      {/* File Status */}
      <div style={styles.fileStatus}>
        <div
          style={styles.fileItem(data.specGenerated)}
          onClick={() => data.specGenerated && setActiveTab("spec")}
        >
          <span style={styles.fileIcon}>📄</span>
          <span style={styles.fileName}>spec.md</span>
          <span style={styles.fileBadge(data.specGenerated ? "ready" : "pending")}>
            {data.specGenerated ? "✅" : "⏳"}
          </span>
        </div>
        <div
          style={styles.fileItem(data.designGenerated)}
          onClick={() => data.designGenerated && setActiveTab("design")}
        >
          <span style={styles.fileIcon}>📐</span>
          <span style={styles.fileName}>design.md</span>
          <span style={styles.fileBadge(data.designGenerated ? "ready" : "pending")}>
            {data.designGenerated ? "✅" : "⏳"}
          </span>
        </div>
        <div
          style={styles.fileItem(data.tasksGenerated)}
          onClick={() => data.tasksGenerated && setActiveTab("tasks")}
        >
          <span style={styles.fileIcon}>📋</span>
          <span style={styles.fileName}>tasks.md</span>
          <span style={styles.fileBadge(data.tasksGenerated ? "ready" : "pending")}>
            {data.tasksGenerated ? "✅" : "⏳"}
          </span>
        </div>
      </div>

      {/* Progress */}
      {data.tasksGenerated && (
        <div style={styles.progressSection}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)" }}>
            📊 Progress
          </div>
          <div style={styles.progressBar}>
            <div style={styles.progressFill(data.progress.percent)} />
          </div>
          <div style={styles.progressText}>
            {data.progress.completed}/{data.progress.total} tasks ({data.progress.percent}%)
          </div>
        </div>
      )}

      {/* Tasks List */}
      {data.tasks.length > 0 && (
        <div style={{ flex: 1, overflow: "auto" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
            📋 Tasks
          </div>
          <div style={styles.tasksList}>
            {data.tasks.map((task) => (
              <div key={task.number} style={styles.taskItem(task.status)}>
                <div style={styles.taskCheckbox(task.status)}>
                  {task.status === "completed" ? "✓" : task.status === "processing" ? "●" : ""}
                </div>
                <div style={styles.taskContent}>
                  <div style={styles.taskNumber}>Task {task.number}</div>
                  <div style={styles.taskName}>{task.name}</div>
                  {task.phase && (
                    <div style={styles.taskPhase}>Phase: {task.phase}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div style={styles.actions}>
        <button
          style={styles.btn}
          onClick={() => window.open(`vscode://file/${process.cwd()}/.openclaw/.tmp/sessions/${data.sessionId}/${data.featureName}`, "_blank")}
        >
          📂 Open Folder
        </button>
        <button
          style={{ ...styles.btn, ...styles.btnPrimary }}
          onClick={() => window.location.reload()}
        >
          🔄 Refresh
        </button>
      </div>
    </div>
  );
}
