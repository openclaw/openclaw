import { useState } from "react";
import type { CronJobCreate, CronSchedule, CronPayload } from "@/lib/types";

const styles = {
  overlay: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "var(--overlay)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: 16,
  },
  modal: {
    background: "var(--card)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "0 8px 30px rgba(0,0,0,0.12)",
    width: "100%",
    maxWidth: 500,
    display: "flex",
    flexDirection: "column" as const,
    maxHeight: "90vh",
  },
  header: {
    padding: "20px 24px",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
    color: "var(--text-strong)",
  },
  closeBtn: {
    background: "none",
    borderWidth: 0,
    fontSize: 24,
    color: "var(--muted)",
    cursor: "pointer",
    lineHeight: 1,
    padding: 0,
  },
  body: {
    padding: 24,
    overflowY: "auto" as const,
    display: "flex",
    flexDirection: "column" as const,
    gap: 16,
  },
  footer: {
    padding: "16px 24px",
    borderTop: "1px solid var(--border)",
    display: "flex",
    justifyContent: "flex-end",
    gap: 12,
  },
  field: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--text)",
  },
  input: {
    height: 36,
    padding: "0 12px",
    fontSize: 14,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--bg)",
    color: "var(--text)",
    outline: "none",
  },
  textarea: {
    padding: "10px 12px",
    fontSize: 14,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--bg)",
    color: "var(--text)",
    outline: "none",
    minHeight: 80,
    fontFamily: "inherit",
    resize: "vertical" as const,
  },
  select: {
    height: 36,
    padding: "0 12px",
    fontSize: 14,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--bg)",
    color: "var(--text)",
    outline: "none",
  },
  btn: {
    height: 36,
    padding: "0 16px",
    fontSize: 14,
    fontWeight: 500,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--secondary)",
    color: "var(--text)",
    cursor: "pointer",
  },
  btnPrimary: {
    background: "var(--accent)",
    color: "#fff",
    borderWidth: 0,
  },
  row: {
    display: "flex",
    gap: 16,
  },
  col: {
    flex: 1,
  },
  errorInfo: {
    color: "var(--danger)",
    fontSize: 13,
    marginTop: -8,
  },
};

interface CreateJobModalProps {
  onClose: () => void;
  onSubmit: (job: CronJobCreate) => Promise<void>;
}

export function CreateJobModal({ onClose, onSubmit }: CreateJobModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scheduleType, setScheduleType] = useState<"every" | "cron" | "at">("every");
  const [everyMins, setEveryMins] = useState("60");
  const [cronExpr, setCronExpr] = useState("* * * * *");
  const [atTime, setAtTime] = useState("");

  const [payloadType, setPayloadType] = useState<"systemEvent" | "agentTurn">("agentTurn");
  const [message, setMessage] = useState("");
  const [agentId, setAgentId] = useState("");

  const [sessionTarget, setSessionTarget] = useState<"isolated" | "main">("isolated");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    if (!message.trim()) {
      setError("Payload message is required");
      return;
    }

    // Validate sessionTarget + payloadType combination
    if (sessionTarget === "main" && payloadType !== "systemEvent") {
      setError(
        'sessionTarget="main" requires Action Type="System Event". Change to "Isolated" for Agent Turn.',
      );
      return;
    }
    if (sessionTarget === "isolated" && payloadType !== "agentTurn") {
      setError(
        'sessionTarget="isolated" requires Action Type="Agent Turn". Change to "Main" for System Event.',
      );
      return;
    }

    let schedule: CronSchedule;
    if (scheduleType === "every") {
      const mins = parseInt(everyMins, 10);
      if (isNaN(mins) || mins <= 0) {
        setError("Invalid minutes interval");
        return;
      }
      schedule = { kind: "every", everyMs: mins * 60000 };
    } else if (scheduleType === "cron") {
      if (!cronExpr.trim()) {
        setError("Cron expression is required");
        return;
      }
      schedule = { kind: "cron", expr: cronExpr };
    } else {
      if (!atTime.trim()) {
        setError("Time is required for 'at' schedule");
        return;
      }
      schedule = { kind: "at", at: atTime };
    }

    let payload: CronPayload;
    if (payloadType === "systemEvent") {
      payload = { kind: "systemEvent", text: message };
    } else {
      payload = { kind: "agentTurn", message };
    }

    const jobDetails: CronJobCreate = {
      name,
      description: description.trim() || undefined,
      enabled: true,
      agentId: agentId.trim() || undefined,
      schedule,
      sessionTarget,
      wakeMode: "now",
      payload,
    };

    setBusy(true);
    try {
      await onSubmit(jobDetails);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", height: "100%" }}
        >
          <div style={styles.header}>
            <h2 style={styles.title}>Create Cron Job</h2>
            <button type="button" style={styles.closeBtn} onClick={onClose}>
              &times;
            </button>
          </div>

          <div style={styles.body}>
            <div style={styles.field}>
              <label style={styles.label}>Name</label>
              <input
                style={styles.input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My daily report"
                autoFocus
              />
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Description (optional)</label>
              <input
                style={styles.input}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Gathers stats and sends to channel"
              />
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Target Agent (optional)</label>
              <input
                style={styles.input}
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="Agent ID (e.g. '@claw')"
              />
            </div>

            <div style={styles.row}>
              <div style={{ ...styles.field, ...styles.col }}>
                <label style={styles.label}>Schedule Type</label>
                <select
                  style={styles.select}
                  value={scheduleType}
                  onChange={(e) => setScheduleType(e.target.value as "every" | "cron" | "at")}
                >
                  <option value="every">Interval (Every X mins)</option>
                  <option value="cron">Cron Expression</option>
                  <option value="at">Specific Time (At)</option>
                </select>
              </div>

              <div style={{ ...styles.field, ...styles.col }}>
                {scheduleType === "every" && (
                  <>
                    <label style={styles.label}>Minutes</label>
                    <input
                      type="number"
                      style={styles.input}
                      value={everyMins}
                      onChange={(e) => setEveryMins(e.target.value)}
                      min="1"
                    />
                  </>
                )}
                {scheduleType === "cron" && (
                  <>
                    <label style={styles.label}>Expression</label>
                    <input
                      style={styles.input}
                      value={cronExpr}
                      onChange={(e) => setCronExpr(e.target.value)}
                      placeholder="* * * * *"
                    />
                  </>
                )}
                {scheduleType === "at" && (
                  <>
                    <label style={styles.label}>ISO Time / Date</label>
                    <input
                      style={styles.input}
                      value={atTime}
                      onChange={(e) => setAtTime(e.target.value)}
                      placeholder="2024-12-31T23:59:59Z"
                    />
                  </>
                )}
              </div>
            </div>

            <div style={styles.row}>
              <div style={{ ...styles.field, ...styles.col }}>
                <label style={styles.label}>Session Target</label>
                <select
                  style={styles.select}
                  value={sessionTarget}
                  onChange={(e) => {
                    const newTarget = e.target.value as "isolated" | "main";
                    setSessionTarget(newTarget);
                    // Auto-adjust payload type to match session target constraint
                    if (newTarget === "main" && payloadType !== "systemEvent") {
                      setPayloadType("systemEvent");
                    } else if (newTarget === "isolated" && payloadType !== "agentTurn") {
                      setPayloadType("agentTurn");
                    }
                  }}
                >
                  <option value="isolated">Isolated (background session)</option>
                  <option value="main">Main (inject into chat)</option>
                </select>
              </div>

              <div style={{ ...styles.field, ...styles.col }}>
                <label style={styles.label}>Action Type</label>
                <select
                  style={styles.select}
                  value={payloadType}
                  onChange={(e) => setPayloadType(e.target.value as "agentTurn" | "systemEvent")}
                  disabled={false}
                >
                  <option value="agentTurn">Agent Turn (isolated only)</option>
                  <option value="systemEvent">System Event (main only)</option>
                </select>
                <span style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                  {sessionTarget === "main"
                    ? "💡 Main target requires System Event"
                    : "💡 Isolated target requires Agent Turn"}
                </span>
              </div>
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Payload Message</label>
              <textarea
                style={styles.textarea}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={
                  payloadType === "agentTurn"
                    ? "E.g. What is the weather right now?"
                    : "E.g. System maintenance started"
                }
              />
            </div>

            {error && <div style={styles.errorInfo}>{error}</div>}
          </div>

          <div style={styles.footer}>
            <button type="button" style={styles.btn} onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" style={{ ...styles.btn, ...styles.btnPrimary }} disabled={busy}>
              {busy ? "Saving..." : "Create Job"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
