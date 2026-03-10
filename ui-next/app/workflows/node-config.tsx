import { Node } from "@xyflow/react";
import { useEffect, useState } from "react";
import type { SessionsListResult, GatewaySessionRow } from "@/lib/types";
import { useGateway } from "@/lib/use-gateway";
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
    borderWidth: 0,
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
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--card)",
    color: "var(--text-strong)",
    outline: "none",
  } as React.CSSProperties,
  textarea: {
    padding: "12px",
    fontSize: 13,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
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
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
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
  const { state, request } = useGateway();
  const [sessions, setSessions] = useState<GatewaySessionRow[]>([]);

  useEffect(() => {
    if (state === "connected") {
      request<SessionsListResult>("sessions.list", {})
        .then((res) => {
          setSessions(res.sessions ?? []);
        })
        .catch((err) => {
          console.error("Failed to load sessions:", err);
        });
    }
  }, [state, request]);

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
              <select
                style={styles.select}
                value={(data.targetSessionKey as string) || ""}
                onChange={(e) => handleChange("targetSessionKey", e.target.value)}
              >
                <option value="">-- Select a session --</option>
                {sessions.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label || s.displayName || s.key}
                  </option>
                ))}
              </select>
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
          <>
            <div style={styles.field}>
              <span style={styles.label}>Channel</span>
              <select
                style={styles.select}
                value={(data.channel as string) || ""}
                onChange={(e) => handleChange("channel", e.target.value)}
              >
                <option value="">-- Select channel --</option>
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
                <option value="telegram">Telegram</option>
                <option value="line">LINE</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="facebook">Facebook Messenger</option>
                <option value="sms">SMS</option>
              </select>
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Recipient ID</span>
              <input
                style={styles.input}
                placeholder="User ID, Channel ID, phone number, or @mention"
                value={(data.recipientId as string) || ""}
                onChange={(e) => handleChange("recipientId", e.target.value)}
              />
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Account (Optional)</span>
              <input
                style={styles.input}
                placeholder="Leave blank for default account"
                value={(data.accountId as string) || ""}
                onChange={(e) => handleChange("accountId", e.target.value)}
              />
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Message Body</span>
              <textarea
                style={styles.textarea}
                placeholder="Hello! Use {{input}} to include previous step's output"
                value={(data.body as string) || ""}
                onChange={(e) => handleChange("body", e.target.value)}
              />
            </div>

            {(data.channel as string) && (data.recipientId as string) ? (
              <div
                style={{
                  padding: "8px 12px",
                  background: "var(--ok-subtle)",
                  color: "var(--ok)",
                  borderRadius: "var(--radius-md)",
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                ✅ Message will be sent to{" "}
                {(data.channel as string).charAt(0).toUpperCase() +
                  (data.channel as string).slice(1)}{" "}
                → {(data.recipientId as string).substring(0, 30)}
                {(data.recipientId as string).length > 30 ? "..." : ""}
              </div>
            ) : (
              <div
                style={{
                  padding: "8px 12px",
                  background: "var(--warning-subtle)",
                  color: "var(--warning)",
                  borderRadius: "var(--radius-md)",
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                ⚠️ Channel and Recipient ID required for delivery
              </div>
            )}
          </>
        )}
        {data.label === "If / Else" && (
          <>
            <div style={styles.field}>
              <span style={styles.label}>Condition Expression</span>
              <textarea
                style={styles.textarea}
                placeholder="input.length > 100&#10;&#10;Supported helpers:&#10;- input.includes('text')&#10;- input.startsWith('...')&#10;- input.length > 50&#10;- variables.myVar === 'value'"
                value={(data.condition as string) || ""}
                onChange={(e) => handleChange("condition", e.target.value)}
              />
            </div>

            <div
              style={{
                padding: "8px 12px",
                background: "var(--info-subtle)",
                color: "var(--info)",
                borderRadius: "var(--radius-md)",
                fontSize: 11,
                lineHeight: 1.5,
              }}
            >
              <strong>Available variables:</strong>
              <br />• <code>input</code> - Output from previous step
              <br />• <code>variables</code> - Custom workflow variables
              <br />• Helpers: <code>includes()</code>, <code>startsWith()</code>,{" "}
              <code>length()</code>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <div style={{ flex: 1 }}>
                <span style={styles.label}>True Branch Label</span>
                <input
                  style={styles.input}
                  placeholder="Yes"
                  value={(data.trueLabel as string) || ""}
                  onChange={(e) => handleChange("trueLabel", e.target.value)}
                />
              </div>

              <div style={{ flex: 1 }}>
                <span style={styles.label}>False Branch Label</span>
                <input
                  style={styles.input}
                  placeholder="No"
                  value={(data.falseLabel as string) || ""}
                  onChange={(e) => handleChange("falseLabel", e.target.value)}
                />
              </div>
            </div>

            {(data.condition as string) ? (
              <div
                style={{
                  padding: "8px 12px",
                  background: "var(--ok-subtle)",
                  color: "var(--ok)",
                  borderRadius: "var(--radius-md)",
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                ✅ Condition configured - workflow will branch based on evaluation
              </div>
            ) : (
              <div
                style={{
                  padding: "8px 12px",
                  background: "var(--warning-subtle)",
                  color: "var(--warning)",
                  borderRadius: "var(--radius-md)",
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                ⚠️ Condition expression required for branching
              </div>
            )}
          </>
        )}

        {/* Execute Tool */}
        {data.label === "Execute Tool" && (
          <>
            <div style={styles.field}>
              <span style={styles.label}>Tool Name</span>
              <input
                style={styles.input}
                placeholder="e.g., browser.navigate, file.read"
                value={(data.toolName as string) || ""}
                onChange={(e) => handleChange("toolName", e.target.value)}
              />
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Tool Arguments (JSON)</span>
              <textarea
                style={styles.textarea}
                placeholder='{"url": "https://example.com"}'
                value={(data.toolArgs as string) || ""}
                onChange={(e) => handleChange("toolArgs", e.target.value)}
              />
            </div>

            <div
              style={{
                padding: "8px 12px",
                background: "var(--ok-subtle)",
                color: "var(--ok)",
                borderRadius: "var(--radius-md)",
                fontSize: 11,
                lineHeight: 1.5,
              }}
            >
              <strong>✅ Available:</strong> Tool execution is ready to use
            </div>
          </>
        )}

        {/* Remote Invoke */}
        {data.label === "Remote Invoke" && (
          <>
            <div style={styles.field}>
              <span style={styles.label}>Target Node</span>
              <select
                style={styles.select}
                value={(data.targetNodeId as string) || ""}
                onChange={(e) => handleChange("targetNodeId", e.target.value)}
              >
                <option value="">-- Select a node --</option>
                <option value="macos-local">macOS (Local)</option>
                <option value="ios-device">iOS Device</option>
                <option value="android-device">Android Device</option>
              </select>
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Command</span>
              <input
                style={styles.input}
                placeholder="e.g., camera.snap, system.run"
                value={(data.command as string) || ""}
                onChange={(e) => handleChange("command", e.target.value)}
              />
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Command Params (JSON)</span>
              <textarea
                style={styles.textarea}
                placeholder='{"facing": "front", "duration": 5000}'
                value={(data.params as string) || ""}
                onChange={(e) => handleChange("params", e.target.value)}
              />
            </div>

            <div
              style={{
                padding: "8px 12px",
                background: "var(--ok-subtle)",
                color: "var(--ok)",
                borderRadius: "var(--radius-md)",
                fontSize: 11,
                lineHeight: 1.5,
              }}
            >
              <strong>✅ Available:</strong> Remote invoke is ready to use
            </div>
          </>
        )}

        {/* Speak (TTS) */}
        {data.label === "Speak (TTS)" && (
          <>
            <div style={styles.field}>
              <span style={styles.label}>Text to Speak</span>
              <textarea
                style={styles.textarea}
                placeholder="Use {{input}} to include previous step's output"
                value={(data.ttsText as string) || ""}
                onChange={(e) => handleChange("ttsText", e.target.value)}
              />
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Provider</span>
              <select
                style={styles.select}
                value={(data.ttsProvider as string) || ""}
                onChange={(e) => handleChange("ttsProvider", e.target.value)}
              >
                <option value="">Auto (use default)</option>
                <option value="openai">OpenAI</option>
                <option value="elevenlabs">ElevenLabs</option>
                <option value="edge">Edge TTS</option>
              </select>
            </div>

            <div
              style={{
                padding: "8px 12px",
                background: "var(--ok-subtle)",
                color: "var(--ok)",
                borderRadius: "var(--radius-md)",
                fontSize: 11,
                lineHeight: 1.5,
              }}
            >
              <strong>✅ Available:</strong> TTS conversion is ready to use
            </div>
          </>
        )}

        {/* Delay */}
        {data.label === "Delay" && (
          <>
            <div style={styles.field}>
              <span style={styles.label}>Duration (milliseconds)</span>
              <input
                style={styles.input}
                type="number"
                placeholder="5000"
                value={(data.durationMs as string) || ""}
                onChange={(e) => handleChange("durationMs", e.target.value)}
              />
            </div>

            <div
              style={{
                padding: "8px 12px",
                background: "var(--ok-subtle)",
                color: "var(--ok)",
                borderRadius: "var(--radius-md)",
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              💡 Common delays: 1000ms (1s), 5000ms (5s), 60000ms (1min)
            </div>
          </>
        )}

        {/* Custom JS */}
        {data.label === "Custom JS" && (
          <>
            <div style={styles.field}>
              <span style={styles.label}>JavaScript Code</span>
              <textarea
                style={{ ...styles.textarea, fontFamily: "monospace", fontSize: 12 }}
                placeholder={`// Transform input data
// Available: input, variables
return input.toUpperCase();`}
                value={(data.jsCode as string) || ""}
                onChange={(e) => handleChange("jsCode", e.target.value)}
              />
            </div>

            <div
              style={{
                padding: "8px 12px",
                background: "var(--ok-subtle)",
                color: "var(--ok)",
                borderRadius: "var(--radius-md)",
                fontSize: 11,
                lineHeight: 1.5,
              }}
            >
              <strong>✅ Available:</strong> Secure JS execution with sandbox (5s timeout, 100KB
              limit)
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
