import { Node } from "@xyflow/react";
import { useEffect, useState } from "react";
import type { SessionsListResult, GatewaySessionRow } from "@/lib/types";
import { useGateway } from "@/lib/use-gateway";
import { NodeData } from "./custom-nodes";
import { SupabaseProfileSelector } from "./supabase-profile-selector";

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
  infoBox: {
    padding: "12px",
    background: "var(--info-subtle)",
    color: "var(--info)",
    borderRadius: "var(--radius-md)",
    fontSize: 11,
    lineHeight: 1.6,
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
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});

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

  // Validate JSON helper
  const validateJson = (value: string, field: string): boolean => {
    if (!value || value.trim() === "") {
      setJsonErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
      return true;
    }
    try {
      JSON.parse(value);
      setJsonErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
      return true;
    } catch (e) {
      setJsonErrors((prev) => ({
        ...prev,
        [field]: "Invalid JSON format",
      }));
      return false;
    }
  };

  const handleChange = (key: string, value: string) => {
    // Validate JSON fields
    if (["filters", "row", "updates", "paramsStr", "outputSchema", "toolArgs", "params"].includes(key)) {
      validateJson(value, key);
    }
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
          <>
            <div style={styles.field}>
              <span style={styles.label}>Cron Expression</span>
              <input
                style={styles.input}
                placeholder="* * * * *"
                value={(data.cronExpr as string) || ""}
                onChange={(e) => handleChange("cronExpr", e.target.value)}
              />
            </div>

            {/* Session Configuration Section */}
            <div style={{ marginTop: 8, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
              <span style={{ ...styles.label, fontWeight: 600, marginBottom: 12, display: "block" }}>
                ⚙️ Session Configuration
              </span>

              <div style={styles.field}>
                <span style={styles.label}>Session Target</span>
                <select
                  style={styles.select}
                  value={(data.sessionTarget as string) || "isolated"}
                  onChange={(e) => handleChange("sessionTarget", e.target.value)}
                >
                  <option value="isolated">Isolated (New session per execution)</option>
                  <option value="reuse">Reuse (Same session for all steps)</option>
                  <option value="main">Main (Use main agent session)</option>
                </select>
              </div>

              <div style={styles.field}>
                <span style={styles.label}>Context Mode</span>
                <select
                  style={styles.select}
                  value={(data.contextMode as string) || "minimal"}
                  onChange={(e) => handleChange("contextMode", e.target.value)}
                >
                  <option value="minimal">Minimal (Only current step input)</option>
                  <option value="full">Full (Include conversation history)</option>
                  <option value="custom">Custom (Define custom context)</option>
                </select>
              </div>

              <div style={styles.field}>
                <span style={styles.label}>Model Override</span>
                <input
                  style={styles.input}
                  placeholder="bailian/qwen3.5-plus"
                  value={(data.modelOverride as string) || ""}
                  onChange={(e) => handleChange("modelOverride", e.target.value)}
                />
              </div>

              <div style={styles.field}>
                <span style={styles.label}>Max Tokens</span>
                <input
                  style={styles.input}
                  type="number"
                  placeholder="4096"
                  value={(data.maxTokens as string) || ""}
                  onChange={(e) => handleChange("maxTokens", e.target.value)}
                />
              </div>

              <div style={styles.field}>
                <span style={styles.label}>Thinking Mode</span>
                <select
                  style={styles.select}
                  value={(data.thinking as string) || "off"}
                  onChange={(e) => handleChange("thinking", e.target.value)}
                >
                  <option value="off">Off (Faster, cheaper)</option>
                  <option value="on">On (Better reasoning)</option>
                </select>
              </div>

              <div style={{ ...styles.infoBox, marginTop: 12 }}>
                <strong>💰 Cost Optimization:</strong>
                <br />• Isolated + Minimal = ~90% token reduction
                <br />• Thinking Off = 2x faster, lower cost
              </div>
            </div>
          </>
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

            {/* Session Configuration Section */}
            <div style={{ marginTop: 8, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
              <span style={{ ...styles.label, fontWeight: 600, marginBottom: 12, display: "block" }}>
                ⚙️ Session Configuration
              </span>

              <div style={styles.field}>
                <span style={styles.label}>Session Target</span>
                <select
                  style={styles.select}
                  value={(data.sessionTarget as string) || "isolated"}
                  onChange={(e) => handleChange("sessionTarget", e.target.value)}
                >
                  <option value="isolated">Isolated (New session per execution)</option>
                  <option value="reuse">Reuse (Same session for all steps)</option>
                  <option value="main">Main (Use main agent session)</option>
                </select>
              </div>

              <div style={styles.field}>
                <span style={styles.label}>Context Mode</span>
                <select
                  style={styles.select}
                  value={(data.contextMode as string) || "minimal"}
                  onChange={(e) => handleChange("contextMode", e.target.value)}
                >
                  <option value="minimal">Minimal (Only current step input)</option>
                  <option value="full">Full (Include conversation history)</option>
                  <option value="custom">Custom (Define custom context)</option>
                </select>
              </div>

              <div style={styles.field}>
                <span style={styles.label}>Model Override</span>
                <input
                  style={styles.input}
                  placeholder="bailian/qwen3.5-plus"
                  value={(data.modelOverride as string) || ""}
                  onChange={(e) => handleChange("modelOverride", e.target.value)}
                />
              </div>

              <div style={styles.field}>
                <span style={styles.label}>Max Tokens</span>
                <input
                  style={styles.input}
                  type="number"
                  placeholder="4096"
                  value={(data.maxTokens as string) || ""}
                  onChange={(e) => handleChange("maxTokens", e.target.value)}
                />
              </div>

              <div style={styles.field}>
                <span style={styles.label}>Thinking Mode</span>
                <select
                  style={styles.select}
                  value={(data.thinking as string) || "off"}
                  onChange={(e) => handleChange("thinking", e.target.value)}
                >
                  <option value="off">Off (Faster, cheaper)</option>
                  <option value="on">On (Better reasoning)</option>
                </select>
              </div>

              <div style={{ ...styles.infoBox, marginTop: 12 }}>
                <strong>💰 Cost Optimization:</strong>
                <br />• Isolated + Minimal = ~90% token reduction
                <br />• Thinking Off = 2x faster, lower cost
              </div>
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

            {/* ✅ NEW: Output Schema Configuration */}
            <div style={styles.field}>
              <span style={styles.label}>Output Schema (JSON Schema)</span>
              <textarea
                style={{ ...styles.textarea, fontFamily: "monospace", fontSize: 11 }}
                placeholder={`{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "description": { "type": "string" }
  },
  "required": ["name", "description"]
}`}
                value={(data.outputSchema as string) || ""}
                onChange={(e) => handleChange("outputSchema", e.target.value)}
              />
            </div>

            <div style={styles.infoBox}>
              <strong>📋 Output Schema:</strong>
              <br />
              Define the JSON structure you want the AI to return.
              <br />
              Next step will receive validated JSON matching this schema.
              <br />
              <a
                href="https://json-schema.org/learn/getting-started-step-by-step"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--info)", textDecoration: "underline" }}
              >
                Learn JSON Schema →
              </a>
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

            <div style={styles.infoBox}>
              <strong>💡 Template Variables:</strong>
              <br />
              • <code>{"{{input}}"}</code> - Output from previous step
              <br />
              • <code>{"{{input.fieldName}}"}</code> - Specific field
              <br />
              • <code>{"{{step1.name}}"}</code> - Output from step 1
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

        {/* Supabase Select */}
        {data.label === "Supabase Select" && (
          <>
            <SupabaseProfileSelector
              value={(data.supabaseInstance as string) || ""}
              onChange={(value) => handleChange("supabaseInstance", value)}
            />

            <div style={styles.field}>
              <span style={styles.label}>Table Name</span>
              <input
                style={styles.input}
                placeholder="users"
                value={(data.table as string) || ""}
                onChange={(e) => handleChange("table", e.target.value)}
              />
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Columns (optional)</span>
              <input
                style={styles.input}
                placeholder="id, name, email, created_at"
                value={(data.columns as string) || ""}
                onChange={(e) => handleChange("columns", e.target.value)}
              />
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Filters (JSON)</span>
              <textarea
                style={{
                  ...styles.textarea,
                  fontFamily: "monospace",
                  fontSize: 11,
                  borderColor: jsonErrors.filters ? "var(--danger)" : "var(--border)",
                }}
                placeholder={`{
  "status": { "eq": "active" },
  "created_at": { "gte": "2026-01-01" }
}`}
                value={(data.filters as string) || ""}
                onChange={(e) => handleChange("filters", e.target.value)}
              />
              {jsonErrors.filters && (
                <span style={{ fontSize: 10, color: "var(--danger)", marginTop: 4 }}>
                  ⚠️ {jsonErrors.filters}
                </span>
              )}
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Limit</span>
              <input
                style={styles.input}
                type="number"
                placeholder="100"
                value={(data.limit as string) || ""}
                onChange={(e) => handleChange("limit", e.target.value)}
              />
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Order By</span>
              <input
                style={styles.input}
                placeholder="created_at DESC"
                value={(data.orderBy as string) || ""}
                onChange={(e) => handleChange("orderBy", e.target.value)}
              />
            </div>

            <div style={styles.infoBox}>
              <strong>📤 Output:</strong> {`{ data: [...], count: number }`}
            </div>
          </>
        )}

        {/* Supabase Insert */}
        {data.label === "Supabase Insert" && (
          <>
            <SupabaseProfileSelector
              value={(data.supabaseInstance as string) || ""}
              onChange={(value) => handleChange("supabaseInstance", value)}
            />

            <div style={styles.field}>
              <span style={styles.label}>Table Name</span>
              <input
                style={styles.input}
                placeholder="users"
                value={(data.table as string) || ""}
                onChange={(e) => handleChange("table", e.target.value)}
              />
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Row Data (JSON)</span>
              <textarea
                style={{
                  ...styles.textarea,
                  fontFamily: "monospace",
                  fontSize: 11,
                  borderColor: jsonErrors.row ? "var(--danger)" : "var(--border)",
                }}
                placeholder={`{
  "name": "{{input.name}}",
  "email": "{{input.email}}",
  "status": "active"
}`}
                value={(data.row as string) || ""}
                onChange={(e) => handleChange("row", e.target.value)}
              />
              {jsonErrors.row && (
                <span style={{ fontSize: 10, color: "var(--danger)", marginTop: 4 }}>
                  ⚠️ {jsonErrors.row}
                </span>
              )}
            </div>

            <div style={styles.infoBox}>
              <strong>💡 Template Variables:</strong>
              <br />• <code>{"{{input.field}}"}</code> - From previous step
              <br />• <code>{"{{step.nodeId.field}}"}</code> - From specific step
            </div>

            <div style={styles.infoBox}>
              <strong>📤 Output:</strong> {`{ id, created_at, ...inserted_row }`}
            </div>
          </>
        )}

        {/* Supabase Update */}
        {data.label === "Supabase Update" && (
          <>
            <SupabaseProfileSelector
              value={(data.supabaseInstance as string) || ""}
              onChange={(value) => handleChange("supabaseInstance", value)}
            />

            <div style={styles.field}>
              <span style={styles.label}>Table Name</span>
              <input
                style={styles.input}
                placeholder="users"
                value={(data.table as string) || ""}
                onChange={(e) => handleChange("table", e.target.value)}
              />
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Filters (JSON)</span>
              <textarea
                style={{
                  ...styles.textarea,
                  fontFamily: "monospace",
                  fontSize: 11,
                  borderColor: jsonErrors.filters ? "var(--danger)" : "var(--border)",
                }}
                placeholder={`{
  "id": { "eq": "123" },
  "status": { "eq": "pending" }
}`}
                value={(data.filters as string) || ""}
                onChange={(e) => handleChange("filters", e.target.value)}
              />
              {jsonErrors.filters && (
                <span style={{ fontSize: 10, color: "var(--danger)", marginTop: 4 }}>
                  ⚠️ {jsonErrors.filters}
                </span>
              )}
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Updates (JSON)</span>
              <textarea
                style={{
                  ...styles.textarea,
                  fontFamily: "monospace",
                  fontSize: 11,
                  borderColor: jsonErrors.updates ? "var(--danger)" : "var(--border)",
                }}
                placeholder={`{
  "status": "completed",
  "updated_at": "{{input.timestamp}}"
}`}
                value={(data.updates as string) || ""}
                onChange={(e) => handleChange("updates", e.target.value)}
              />
              {jsonErrors.updates && (
                <span style={{ fontSize: 10, color: "var(--danger)", marginTop: 4 }}>
                  ⚠️ {jsonErrors.updates}
                </span>
              )}
            </div>

            <div style={styles.infoBox}>
              <strong>📤 Output:</strong> {`{ count: number }`}
            </div>
          </>
        )}

        {/* Supabase Delete */}
        {data.label === "Supabase Delete" && (
          <>
            <SupabaseProfileSelector
              value={(data.supabaseInstance as string) || ""}
              onChange={(value) => handleChange("supabaseInstance", value)}
            />

            <div style={styles.field}>
              <span style={styles.label}>Table Name</span>
              <input
                style={styles.input}
                placeholder="users"
                value={(data.table as string) || ""}
                onChange={(e) => handleChange("table", e.target.value)}
              />
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Filters (JSON)</span>
              <textarea
                style={{
                  ...styles.textarea,
                  fontFamily: "monospace",
                  fontSize: 11,
                  borderColor: jsonErrors.filters ? "var(--danger)" : "var(--border)",
                }}
                placeholder={`{
  "status": { "eq": "inactive" },
  "created_at": { "lt": "2025-01-01" }
}`}
                value={(data.filters as string) || ""}
                onChange={(e) => handleChange("filters", e.target.value)}
              />
              {jsonErrors.filters && (
                <span style={{ fontSize: 10, color: "var(--danger)", marginTop: 4 }}>
                  ⚠️ {jsonErrors.filters}
                </span>
              )}
            </div>

            <div style={styles.infoBox}>
              <strong>📤 Output:</strong> {`{ count: number }`}
            </div>
          </>
        )}

        {/* Supabase RPC */}
        {data.label === "Supabase RPC" && (
          <>
            <SupabaseProfileSelector
              value={(data.supabaseInstance as string) || ""}
              onChange={(value) => handleChange("supabaseInstance", value)}
            />

            <div style={styles.field}>
              <span style={styles.label}>Function Name</span>
              <input
                style={styles.input}
                placeholder="calculate_total"
                value={(data.function as string) || ""}
                onChange={(e) => handleChange("function", e.target.value)}
              />
            </div>

            <div style={styles.field}>
              <span style={styles.label}>Parameters (JSON)</span>
              <textarea
                style={{
                  ...styles.textarea,
                  fontFamily: "monospace",
                  fontSize: 11,
                  borderColor: jsonErrors.paramsStr ? "var(--danger)" : "var(--border)",
                }}
                placeholder={`{
  "user_id": "123",
  "start_date": "2026-01-01",
  "end_date": "2026-12-31"
}`}
                value={(data.paramsStr as string) || ""}
                onChange={(e) => handleChange("paramsStr", e.target.value)}
              />
              {jsonErrors.paramsStr && (
                <span style={{ fontSize: 10, color: "var(--danger)", marginTop: 4 }}>
                  ⚠️ {jsonErrors.paramsStr}
                </span>
              )}
            </div>

            <div style={styles.infoBox}>
              <strong>📤 Output:</strong> {`{ result: any }`}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
