"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { clampText } from "@/lib/format";
import type { SkillStatusReport, SkillStatusEntry } from "@/lib/types";
import { useGateway } from "@/lib/use-gateway";

// ============================================
// Types
// ============================================

type SkillGroup = {
  id: string;
  label: string;
  skills: SkillStatusEntry[];
};

type SkillMessageMap = Record<string, { kind: "success" | "error"; message: string }>;

// ============================================
// Helpers
// ============================================

const SKILL_SOURCE_GROUPS = [
  {
    id: "workspace",
    label: "Workspace Skills",
    sources: ["openclaw-workspace"],
  },
  { id: "built-in", label: "Built-in Skills", sources: ["openclaw-bundled"] },
  { id: "installed", label: "Installed Skills", sources: ["openclaw-managed"] },
  { id: "extra", label: "Extra Skills", sources: ["openclaw-extra"] },
];

function groupSkills(skills: SkillStatusEntry[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const def of SKILL_SOURCE_GROUPS) {
    groups.set(def.id, { id: def.id, label: def.label, skills: [] });
  }
  const builtInGroup = SKILL_SOURCE_GROUPS.find((g) => g.id === "built-in");
  const other: SkillGroup = { id: "other", label: "Other Skills", skills: [] };

  for (const skill of skills) {
    const match = skill.bundled
      ? builtInGroup
      : SKILL_SOURCE_GROUPS.find((g) => g.sources.includes(skill.source));
    if (match) {
      groups.get(match.id)?.skills.push(skill);
    } else {
      other.skills.push(skill);
    }
  }

  const ordered = SKILL_SOURCE_GROUPS.map((g) => groups.get(g.id)).filter((g): g is SkillGroup =>
    Boolean(g && g.skills.length > 0),
  );
  if (other.skills.length > 0) {
    ordered.push(other);
  }
  return ordered;
}

function computeSkillMissing(skill: SkillStatusEntry): string[] {
  return [
    ...skill.missing.bins.map((b) => `bin:${b}`),
    ...skill.missing.env.map((e) => `env:${e}`),
    ...skill.missing.config.map((c) => `config:${c}`),
    ...skill.missing.os.map((o) => `os:${o}`),
  ];
}

function computeSkillReasons(skill: SkillStatusEntry): string[] {
  const reasons: string[] = [];
  if (skill.disabled) reasons.push("disabled");
  if (skill.blockedByAllowlist) reasons.push("blocked by allowlist");
  return reasons;
}

// ============================================
// Styles
// ============================================

const styles = {
  card: {
    background: "var(--card)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: 20,
    maxWidth: "100%",
    overflow: "hidden",
  } as React.CSSProperties,
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
  } as React.CSSProperties,
  cardTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: "var(--text-strong)",
    margin: 0,
  } as React.CSSProperties,
  cardSub: {
    fontSize: 13,
    color: "var(--muted)",
    marginTop: 4,
  } as React.CSSProperties,
  btn: {
    height: 28,
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 500,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--secondary)",
    color: "var(--text)",
    cursor: "pointer",
  } as React.CSSProperties,
  btnPrimary: {
    background: "var(--accent)",
    color: "#fff",
    borderColor: "var(--accent)",
  } as React.CSSProperties,
  filters: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginTop: 14,
  } as React.CSSProperties,
  field: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  label: {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--muted)",
  } as React.CSSProperties,
  input: {
    height: 32,
    padding: "0 10px",
    fontSize: 13,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--bg)",
    color: "var(--text)",
    outline: "none",
  } as React.CSSProperties,
  muted: {
    color: "var(--muted)",
    fontSize: 13,
  } as React.CSSProperties,
  callout: {
    padding: "10px 14px",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    marginTop: 12,
  } as React.CSSProperties,
  calloutDanger: {
    background: "var(--danger-subtle)",
    color: "var(--danger)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--danger)",
  } as React.CSSProperties,
  groupDetails: {
    marginTop: 16,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
    maxWidth: "100%",
  } as React.CSSProperties,
  groupSummary: {
    padding: "12px 16px",
    background: "var(--bg)",
    cursor: "pointer",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontWeight: 500,
    fontSize: 14,
    color: "var(--text-strong)",
    listStyle: "none",
  } as React.CSSProperties,
  skillItem: {
    padding: "16px",
    borderTop: "1px solid var(--border)",
    display: "flex",
    justifyContent: "space-between",
    gap: 16,
    background: "var(--card)",
    overflow: "hidden",
    maxWidth: "100%",
  } as React.CSSProperties,
  skillMain: {
    flex: 1,
    minWidth: 0,
    maxWidth: "100%",
  } as React.CSSProperties,
  skillTitle: {
    fontSize: 14,
    fontWeight: 500,
    color: "var(--text-strong)",
    wordBreak: "break-word" as const,
    overflowWrap: "break-word" as const,
  } as React.CSSProperties,
  skillSub: {
    fontSize: 13,
    color: "var(--muted)",
    marginTop: 4,
    wordBreak: "break-word" as const,
    overflowWrap: "break-word" as const,
  } as React.CSSProperties,
  chipRow: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 6,
    marginTop: 8,
    maxWidth: "100%",
  } as React.CSSProperties,
  chip: {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 500,
    borderRadius: 9999,
    background: "var(--bg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    color: "var(--muted)",
  } as React.CSSProperties,
  chipOk: {
    background: "var(--ok-subtle)",
    borderColor: "var(--ok)",
    color: "var(--ok)",
  } as React.CSSProperties,
  chipWarn: {
    background: "var(--warn-subtle)",
    borderColor: "var(--warn)",
    color: "var(--warn)",
  } as React.CSSProperties,
  skillMeta: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "flex-end",
    gap: 8,
    flexShrink: 0,
    minWidth: 100,
  } as React.CSSProperties,
  row: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap" as const,
    justifyContent: "flex-end",
  } as React.CSSProperties,
};

// ============================================
// SkillItem Component
// ============================================

function SkillItem({
  skill,
  busy,
  apiKey,
  message,
  onToggle,
  onEdit,
  onSaveKey,
  onInstall,
}: {
  skill: SkillStatusEntry;
  busy: boolean;
  apiKey: string;
  message: { kind: "success" | "error"; message: string } | null;
  onToggle: () => void;
  onEdit: (value: string) => void;
  onSaveKey: () => void;
  onInstall: () => void;
}) {
  const canInstall = skill.install.length > 0 && skill.missing.bins.length > 0;
  const showBundledBadge = Boolean(skill.bundled && skill.source !== "openclaw-bundled");
  const missing = computeSkillMissing(skill);
  const reasons = computeSkillReasons(skill);

  return (
    <div style={styles.skillItem}>
      <div style={styles.skillMain}>
        <div style={styles.skillTitle}>
          {skill.emoji ? `${skill.emoji} ` : ""}
          {skill.name}
        </div>
        <div style={styles.skillSub}>{clampText(skill.description, 140)}</div>

        <div style={styles.chipRow}>
          <span style={styles.chip}>{skill.source}</span>
          {showBundledBadge && <span style={styles.chip}>bundled</span>}
          <span
            style={{
              ...styles.chip,
              ...(skill.eligible ? styles.chipOk : styles.chipWarn),
            }}
          >
            {skill.eligible ? "eligible" : "blocked"}
          </span>
          {skill.disabled && <span style={{ ...styles.chip, ...styles.chipWarn }}>disabled</span>}
        </div>

        {missing.length > 0 && (
          <div style={{ ...styles.muted, marginTop: 6 }}>Missing: {missing.join(", ")}</div>
        )}
        {reasons.length > 0 && (
          <div style={{ ...styles.muted, marginTop: 6 }}>Reason: {reasons.join(", ")}</div>
        )}
      </div>

      <div style={styles.skillMeta}>
        <div style={styles.row}>
          <button style={styles.btn} disabled={busy} onClick={onToggle}>
            {skill.disabled ? "Enable" : "Disable"}
          </button>
          {canInstall && (
            <button style={styles.btn} disabled={busy} onClick={onInstall}>
              {busy ? "Installing…" : skill.install[0].label}
            </button>
          )}
        </div>

        {message && (
          <div
            style={{
              fontSize: 12,
              color: message.kind === "error" ? "var(--danger)" : "var(--ok)",
            }}
          >
            {message.message}
          </div>
        )}

        {skill.primaryEnv && (
          <>
            <div style={{ ...styles.field, marginTop: 4 }}>
              <span style={styles.label}>API key</span>
              <input
                type="password"
                style={styles.input}
                value={apiKey}
                onChange={(e) => onEdit(e.target.value)}
              />
            </div>
            <button
              style={{ ...styles.btn, ...styles.btnPrimary }}
              disabled={busy}
              onClick={onSaveKey}
            >
              Save key
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================
// SkillGroup Component
// ============================================

function SkillGroupSection({
  group,
  busyKey,
  edits,
  messages,
  defaultOpen,
  onToggle,
  onEdit,
  onSaveKey,
  onInstall,
}: {
  group: SkillGroup;
  busyKey: string | null;
  edits: Record<string, string>;
  messages: SkillMessageMap;
  defaultOpen: boolean;
  onToggle: (skillKey: string, enabled: boolean) => void;
  onEdit: (skillKey: string, value: string) => void;
  onSaveKey: (skillKey: string) => void;
  onInstall: (skillKey: string, name: string, installId: string) => void;
}) {
  return (
    <details style={styles.groupDetails} open={defaultOpen}>
      <summary style={styles.groupSummary}>
        <span>{group.label}</span>
        <span style={{ color: "var(--muted)", fontWeight: 400 }}>{group.skills.length}</span>
      </summary>
      <div>
        {group.skills.map((skill) => (
          <SkillItem
            key={skill.skillKey}
            skill={skill}
            busy={busyKey === skill.skillKey}
            apiKey={edits[skill.skillKey] ?? ""}
            message={messages[skill.skillKey] ?? null}
            onToggle={() => onToggle(skill.skillKey, skill.disabled)}
            onEdit={(value) => onEdit(skill.skillKey, value)}
            onSaveKey={() => onSaveKey(skill.skillKey)}
            onInstall={() => onInstall(skill.skillKey, skill.name, skill.install[0]?.id ?? "")}
          />
        ))}
      </div>
    </details>
  );
}

// ============================================
// Main Skills Page
// ============================================

export default function SkillsPage() {
  const { state, request } = useGateway();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<SkillStatusReport | null>(null);
  const [filter, setFilter] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<SkillMessageMap>({});

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [createSkillKey, setCreateSkillKey] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createInstructions, setCreateInstructions] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleCreateSkill = async () => {
    if (!createSkillKey || !createDescription || !createInstructions) {
      setCreateError("All fields are required");
      return;
    }
    setCreateLoading(true);
    setCreateError(null);
    try {
      await request("skills.create", {
        skillKey: createSkillKey,
        description: createDescription,
        instructions: createInstructions,
      });
      setIsCreateModalOpen(false);
      setCreateSkillKey("");
      setCreateDescription("");
      setCreateInstructions("");
      await loadSkills();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create skill");
    } finally {
      setCreateLoading(false);
    }
  };

  const loadSkills = useCallback(async () => {
    if (state !== "connected") return;

    setLoading(true);
    setError(null);

    try {
      const res = await request<SkillStatusReport>("skills.status", {});
      setReport(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, [state, request]);

  useEffect(() => {
    if (state === "connected") {
      loadSkills();
    }
  }, [state, loadSkills]);

  const filteredSkills = useMemo(() => {
    const skills = report?.skills ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) =>
      [s.name, s.description, s.source].join(" ").toLowerCase().includes(q),
    );
  }, [report, filter]);

  const groups = useMemo(() => groupSkills(filteredSkills), [filteredSkills]);

  const handleToggle = useCallback(
    async (skillKey: string, currentlyDisabled: boolean) => {
      setBusyKey(skillKey);
      setMessages((m) => ({ ...m, [skillKey]: undefined }) as SkillMessageMap);
      try {
        await request("skills.update", {
          skillKey,
          enabled: currentlyDisabled,
        });
        setMessages((m) => ({
          ...m,
          [skillKey]: {
            kind: "success",
            message: currentlyDisabled ? "Enabled" : "Disabled",
          },
        }));
        await loadSkills();
      } catch (err) {
        setMessages((m) => ({
          ...m,
          [skillKey]: {
            kind: "error",
            message: err instanceof Error ? err.message : "Failed",
          },
        }));
      } finally {
        setBusyKey(null);
      }
    },
    [request, loadSkills],
  );

  const handleEdit = useCallback((skillKey: string, value: string) => {
    setEdits((e) => ({ ...e, [skillKey]: value }));
  }, []);

  const handleSaveKey = useCallback(
    async (skillKey: string) => {
      const value = edits[skillKey];
      if (!value) return;
      setBusyKey(skillKey);
      try {
        const skill = report?.skills.find((s) => s.skillKey === skillKey);
        if (skill?.primaryEnv) {
          await request("skills.update", { skillKey, apiKey: value });
          setMessages((m) => ({
            ...m,
            [skillKey]: { kind: "success", message: "Key saved" },
          }));
          setEdits((e) => ({ ...e, [skillKey]: "" }));
        }
      } catch (err) {
        setMessages((m) => ({
          ...m,
          [skillKey]: {
            kind: "error",
            message: err instanceof Error ? err.message : "Failed",
          },
        }));
      } finally {
        setBusyKey(null);
      }
    },
    [edits, report, request],
  );

  const handleInstall = useCallback(
    async (skillKey: string, name: string, installId: string) => {
      if (!installId) return;
      setBusyKey(skillKey);
      try {
        await request("skills.install", { name, installId });
        setMessages((m) => ({
          ...m,
          [skillKey]: { kind: "success", message: "Installed" },
        }));
        await loadSkills();
      } catch (err) {
        setMessages((m) => ({
          ...m,
          [skillKey]: {
            kind: "error",
            message: err instanceof Error ? err.message : "Failed",
          },
        }));
      } finally {
        setBusyKey(null);
      }
    },
    [request, loadSkills],
  );

  const isDisabled = loading || state !== "connected";

  return (
    <div style={{ animation: "rise 0.3s ease-out" }}>
      <div style={{ marginBottom: 24 }}>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.025em",
            color: "var(--text-strong)",
            margin: 0,
          }}
        >
          Skills
        </h1>
        <p style={{ color: "var(--muted)", marginTop: 6, marginBottom: 0 }}>
          Bundled, managed, and workspace skills.
        </p>
      </div>

      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <div>
            <div style={styles.cardTitle}>Skills</div>
            <div style={styles.cardSub}>
              {filteredSkills.length} of {report?.skills.length ?? 0} shown
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              style={{ ...styles.btn, ...styles.btnPrimary }}
              disabled={isDisabled}
              onClick={() => setIsCreateModalOpen(true)}
            >
              Create Skill
            </button>
            <button style={styles.btn} disabled={isDisabled} onClick={loadSkills}>
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>

        <div style={styles.filters}>
          <div style={styles.field}>
            <span style={styles.label}>Filter</span>
            <input
              style={styles.input}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search skills"
            />
          </div>
        </div>

        {error && <div style={{ ...styles.callout, ...styles.calloutDanger }}>{error}</div>}

        {filteredSkills.length === 0 ? (
          <div style={{ ...styles.muted, marginTop: 16 }}>
            {loading ? "Loading skills..." : "No skills found."}
          </div>
        ) : (
          groups.map((group) => (
            <SkillGroupSection
              key={group.id}
              group={group}
              busyKey={busyKey}
              edits={edits}
              messages={messages}
              defaultOpen={group.id !== "workspace" && group.id !== "built-in"}
              onToggle={handleToggle}
              onEdit={handleEdit}
              onSaveKey={handleSaveKey}
              onInstall={handleInstall}
            />
          ))
        )}
      </div>

      {isCreateModalOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <div
            style={{
              background: "var(--card)",
              padding: 24,
              borderRadius: "var(--radius-lg)",
              width: 1800,
              maxWidth: "90vw",
              maxHeight: "90vh",
              overflow: "auto",
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: "var(--border)",
            }}
          >
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Create New Skill</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
              <div style={styles.field}>
                <label style={styles.label}>Skill Name (ID)</label>
                <input
                  style={styles.input}
                  value={createSkillKey}
                  onChange={(e) => setCreateSkillKey(e.target.value)}
                  placeholder="e.g. weather-lookup"
                />
              </div>
              <div style={styles.field}>
                <label style={styles.label}>Description</label>
                <input
                  style={styles.input}
                  value={createDescription}
                  onChange={(e) => setCreateDescription(e.target.value)}
                  placeholder="Brief summary of what this skill does"
                />
              </div>
              <div style={styles.field}>
                <label style={styles.label}>Instructions</label>
                <textarea
                  style={{ ...styles.input, height: 400, maxHeight: "50vh", padding: "8px 10px", resize: "vertical", overflow: "auto" }}
                  value={createInstructions}
                  onChange={(e) => setCreateInstructions(e.target.value)}
                  placeholder="Markdown instructions"
                />
              </div>
              {createError && (
                <div style={{ color: "var(--danger)", fontSize: 13 }}>{createError}</div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
                <button style={styles.btn} onClick={() => setIsCreateModalOpen(false)}>
                  Cancel
                </button>
                <button
                  style={{ ...styles.btn, ...styles.btnPrimary }}
                  onClick={handleCreateSkill}
                  disabled={createLoading}
                >
                  {createLoading ? "Saving..." : "Create"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
