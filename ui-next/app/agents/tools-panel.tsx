"use client";

import { useEffect, useState, useCallback } from "react";
import {
  isAllowedByPolicy,
  matchesList,
  normalizeToolName,
  resolveToolProfile,
} from "@/lib/tools-utils";
import type { ToolsCatalogResult, SkillStatusReport, ConfigSnapshot } from "@/lib/types";

type ToolsPanelProps = {
  agentId: string;
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
};

// ============================================
// Shared types and helpers
// ============================================

type AgentConfigEntry = {
  id: string;
  skills?: string[];
  tools?: {
    profile?: string;
    allow?: string[];
    alsoAllow?: string[];
    deny?: string[];
  };
};

function resolveAgentConfig(configForm: Record<string, unknown> | null, agentId: string) {
  const cfg = configForm as ConfigSnapshot["config"];
  const list = (cfg?.agents as { list: AgentConfigEntry[] })?.list as
    | AgentConfigEntry[]
    | undefined;
  const entry = list?.find((agent) => agent?.id === agentId);
  return {
    entry,
    defaults: (cfg?.agents as { defaults: AgentConfigEntry[] })?.defaults,
    globalTools: cfg?.tools as AgentConfigEntry["tools"],
  };
}

const styles = {
  card: {
    background: "var(--card)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: 20,
    marginBottom: 20,
  } as React.CSSProperties,
  row: {
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
  mono: {
    fontFamily: "var(--mono)",
  } as React.CSSProperties,
  buttonsRow: {
    display: "flex",
    gap: 8,
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
    height: 28,
    padding: "0 14px",
    fontSize: 12,
    fontWeight: 600,
    borderWidth: 0,
    borderRadius: "var(--radius-md)",
    background: "var(--accent)",
    color: "#fff",
    cursor: "pointer",
  } as React.CSSProperties,
  btnActive: {
    borderColor: "var(--accent)",
    background: "var(--accent-subtle)",
    color: "var(--accent)",
  } as React.CSSProperties,
  calloutInfo: {
    background: "var(--info-subtle, rgba(56, 189, 248, 0.1))",
    color: "var(--info, #38bdf8)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--info, #38bdf8)",
    padding: "10px 14px",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    marginTop: 12,
  } as React.CSSProperties,
  calloutWarn: {
    background: "var(--warn-subtle, rgba(250, 204, 21, 0.1))",
    color: "var(--warn, #facc15)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--warn, #facc15)",
    padding: "10px 14px",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    marginTop: 12,
  } as React.CSSProperties,
  agentKv: {
    display: "flex",
    gap: 12,
    marginBottom: 8,
    fontSize: 13,
  } as React.CSSProperties,
  kvLabel: {
    width: 80,
    color: "var(--muted)",
  } as React.CSSProperties,
  toolsGrid: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 20,
    marginTop: 20,
  } as React.CSSProperties,
  toolSection: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
  } as React.CSSProperties,
  toolSectionHeader: {
    background: "var(--bg-hover)",
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 600,
    borderBottom: "1px solid var(--border)",
  } as React.CSSProperties,
  toolRow: {
    padding: "10px 14px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid var(--border)",
  } as React.CSSProperties,
  toolTitle: {
    fontSize: 13,
    fontWeight: 600,
    fontFamily: "var(--mono)",
  } as React.CSSProperties,
  toolSub: {
    fontSize: 12,
    color: "var(--muted)",
    marginTop: 4,
  } as React.CSSProperties,
  toggleLabel: {
    position: "relative",
    display: "inline-block",
    width: 36,
    height: 20,
  } as React.CSSProperties,
  checkboxOrigin: {
    opacity: 0,
    width: 0,
    height: 0,
  } as React.CSSProperties,
  track: {
    position: "absolute",
    cursor: "pointer",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "var(--border)",
    transition: ".2s",
    borderRadius: 20,
  } as React.CSSProperties,
  trackActive: {
    backgroundColor: "var(--accent)",
  } as React.CSSProperties,
  knob: {
    position: "absolute",
    content: '""',
    height: 16,
    width: 16,
    left: 2,
    bottom: 2,
    backgroundColor: "white",
    transition: ".2s",
    borderRadius: "50%",
  } as React.CSSProperties,
  knobActive: {
    transform: "translateX(16px)",
  } as React.CSSProperties,
};

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      style={{
        ...styles.toggleLabel,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={styles.checkboxOrigin}
      />
      <span
        style={{
          ...styles.track,
          ...(checked ? styles.trackActive : {}),
        }}
      >
        <span
          style={{
            ...styles.knob,
            ...(checked ? styles.knobActive : {}),
          }}
        />
      </span>
    </label>
  );
}

// ============================================
// ToolsPanel Component
// ============================================

export function ToolsPanel({ agentId, request }: ToolsPanelProps) {
  const [configForm, setConfigForm] = useState<Record<string, unknown> | null>(null);
  const [configHash, setConfigHash] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);

  const [toolsCatalogResult, setToolsCatalogResult] = useState<ToolsCatalogResult | null>(null);
  const [toolsCatalogLoading, setToolsCatalogLoading] = useState(false);
  const [toolsCatalogError, setToolsCatalogError] = useState<string | null>(null);

  const [skillsReport, setSkillsReport] = useState<SkillStatusReport | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillsFilter, setSkillsFilter] = useState("");

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    try {
      const res = await request<ConfigSnapshot>("config.get");
      setConfigForm(res.config ?? {});
      setConfigHash(res.hash ?? null);
      setConfigDirty(false);
    } catch (e) {
      console.error(e);
    } finally {
      setConfigLoading(false);
    }
  }, [request]);

  const loadTools = useCallback(async () => {
    setToolsCatalogLoading(true);
    setToolsCatalogError(null);
    try {
      const res = await request<ToolsCatalogResult>("tools.catalog", { agentId });
      setToolsCatalogResult(res);
    } catch (e) {
      setToolsCatalogError(e instanceof Error ? e.message : "Failed to load tools");
    } finally {
      setToolsCatalogLoading(false);
    }
  }, [agentId, request]);

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const res = await request<SkillStatusReport>("skills.status", { agentId });
      setSkillsReport(res);
    } catch (e) {
      setSkillsError(e instanceof Error ? e.message : "Failed to load skills");
    } finally {
      setSkillsLoading(false);
    }
  }, [agentId, request]);

  useEffect(() => {
    void loadConfig();
    void loadTools();
    void loadSkills();
  }, [agentId, loadConfig, loadTools, loadSkills]);

  const handleConfigSave = async () => {
    if (!configForm || !configHash) {
      return;
    }
    setConfigSaving(true);
    try {
      const raw = JSON.stringify(configForm);
      await request("config.set", { raw, baseHash: configHash });
      setConfigDirty(false);
    } catch (e) {
      console.error("Failed to save config:", e);
    } finally {
      setConfigSaving(false);
    }
  };

  const updateAgentTools = (
    updater: (agentToolsObj: NonNullable<AgentConfigEntry["tools"]>) => void,
  ) => {
    if (!configForm) {
      return;
    }
    const newConfig = JSON.parse(JSON.stringify(configForm)) as typeof configForm;
    newConfig.agents = newConfig.agents || {};
    const agents = newConfig.agents as { list?: AgentConfigEntry[] };
    agents.list = agents.list || [];
    let agentEntry = agents.list.find((a) => a.id === agentId);
    if (!agentEntry) {
      agentEntry = { id: agentId };
      agents.list.push(agentEntry);
    }
    agentEntry.tools = agentEntry.tools || {};
    updater(agentEntry.tools);
    setConfigForm(newConfig);
    setConfigDirty(true);
  };

  const handleProfileChange = (profile: string | null, clearAllow: boolean) => {
    updateAgentTools((tools) => {
      tools.profile = profile || undefined;
      if (clearAllow) {
        tools.alsoAllow = [];
        tools.deny = [];
      }
    });
  };

  const handleOverridesChange = (alsoAllow: string[], deny: string[]) => {
    updateAgentTools((tools) => {
      tools.alsoAllow = alsoAllow.length > 0 ? alsoAllow : undefined;
      tools.deny = deny.length > 0 ? deny : undefined;
    });
  };

  const updateAgentSkills = (updater: (agentEntry: AgentConfigEntry) => void) => {
    if (!configForm) {
      return;
    }
    const newConfig = JSON.parse(JSON.stringify(configForm)) as typeof configForm;
    newConfig.agents = newConfig.agents || {};
    const agents = newConfig.agents as { list?: AgentConfigEntry[] };
    agents.list = agents.list || [];
    let agentEntry = agents.list.find((a) => a.id === agentId);
    if (!agentEntry) {
      agentEntry = { id: agentId };
      agents.list.push(agentEntry);
    }
    updater(agentEntry);
    setConfigForm(newConfig);
    setConfigDirty(true);
  };

  const handleSkillToggle = (skillName: string, enabled: boolean) => {
    updateAgentSkills((entry) => {
      const skills = entry.skills;
      if (skills === undefined) {
        // If it was using everything, we create an allowlist mapping all known skills
        // minus this one.
        const allKnown = skillsReport?.skills.map((s) => s.name) ?? [];
        entry.skills = allKnown.filter((s) => s !== skillName);
      } else {
        const set = new Set(skills);
        if (enabled) {
          set.add(skillName);
        } else {
          set.delete(skillName);
        }
        entry.skills = Array.from(set);
      }
    });
  };

  const handleSkillClear = () => {
    updateAgentSkills((entry) => {
      entry.skills = undefined;
    });
  };

  const handleSkillDisableAll = () => {
    updateAgentSkills((entry) => {
      entry.skills = [];
    });
  };

  // Rendering Tool Access
  const config = resolveAgentConfig(configForm, agentId);
  const agentTools = config.entry?.tools ?? {};
  const globalTools = config.globalTools ?? {};
  const profile = agentTools.profile ?? globalTools.profile ?? "full";
  const profileSource = agentTools.profile
    ? "agent override"
    : globalTools.profile
      ? "global default"
      : "default";

  const hasAgentAllow = Array.isArray(agentTools.allow) && agentTools.allow.length > 0;
  const hasGlobalAllow = Array.isArray(globalTools.allow) && globalTools.allow.length > 0;
  const toolsEditable = Boolean(configForm) && !configLoading && !configSaving && !hasAgentAllow;

  const alsoAllow = hasAgentAllow
    ? []
    : Array.isArray(agentTools.alsoAllow)
      ? agentTools.alsoAllow
      : [];
  const deny = hasAgentAllow ? [] : Array.isArray(agentTools.deny) ? agentTools.deny : [];
  const basePolicy = hasAgentAllow
    ? { allow: agentTools.allow ?? [], deny: agentTools.deny ?? [] }
    : (resolveToolProfile(profile) ?? undefined);

  const sections = toolsCatalogResult?.groups || [];
  const profileOptions = toolsCatalogResult?.profiles || [];
  const toolIds = sections.flatMap((s) => s.tools.map((t) => t.id));

  const resolveAllowed = (toolId: string) => {
    const baseAllowed = isAllowedByPolicy(toolId, basePolicy);
    const extraAllowed = matchesList(toolId, alsoAllow);
    const denied = matchesList(toolId, deny);
    const allowed = (baseAllowed || extraAllowed) && !denied;
    return { allowed, baseAllowed, denied };
  };

  const toolsEnabledCount = toolIds.filter((t) => resolveAllowed(t).allowed).length;

  const updateTool = (toolId: string, nextEnabled: boolean) => {
    const nextAllow = new Set(alsoAllow.map(normalizeToolName).filter(Boolean));
    const nextDeny = new Set(deny.map(normalizeToolName).filter(Boolean));
    const { baseAllowed } = resolveAllowed(toolId);
    const normalized = normalizeToolName(toolId);
    if (nextEnabled) {
      nextDeny.delete(normalized);
      if (!baseAllowed) {
        nextAllow.add(normalized);
      }
    } else {
      nextAllow.delete(normalized);
      nextDeny.add(normalized);
    }
    handleOverridesChange([...nextAllow], [...nextDeny]);
  };

  const updateAllTools = (nextEnabled: boolean) => {
    const nextAllow = new Set(alsoAllow.map(normalizeToolName).filter(Boolean));
    const nextDeny = new Set(deny.map(normalizeToolName).filter(Boolean));
    for (const toolId of toolIds) {
      const { baseAllowed } = resolveAllowed(toolId);
      const normalized = normalizeToolName(toolId);
      if (nextEnabled) {
        nextDeny.delete(normalized);
        if (!baseAllowed) {
          nextAllow.add(normalized);
        }
      } else {
        nextAllow.delete(normalized);
        nextDeny.add(normalized);
      }
    }
    handleOverridesChange([...nextAllow], [...nextDeny]);
  };

  // Rendering Skills
  const allowlist = Array.isArray(config.entry?.skills) ? config.entry?.skills : undefined;
  const allowSet = new Set((allowlist ?? []).map((n) => n.trim()).filter(Boolean));
  const usingAllowlist = allowlist !== undefined;
  const rawSkills = skillsReport?.skills ?? [];
  const filteredSkills = skillsFilter
    ? rawSkills.filter((s) =>
        [s.name, s.description, s.source]
          .join(" ")
          .toLowerCase()
          .includes(skillsFilter.toLowerCase()),
      )
    : rawSkills;

  const skillsEnabledCount = usingAllowlist
    ? rawSkills.filter((s) => allowSet.has(s.name)).length
    : rawSkills.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Tool Access Section */}
      <section style={styles.card}>
        <div style={styles.row}>
          <div>
            <div style={styles.cardTitle}>Tool Access</div>
            <div style={styles.cardSub}>
              Profile + per-tool overrides for this agent.{" "}
              <span style={styles.mono}>
                {toolsEnabledCount}/{toolIds.length}
              </span>{" "}
              enabled.
            </div>
          </div>
          <div style={styles.buttonsRow}>
            <button
              style={styles.btn}
              disabled={!toolsEditable}
              onClick={() => updateAllTools(true)}
            >
              Enable All
            </button>
            <button
              style={styles.btn}
              disabled={!toolsEditable}
              onClick={() => updateAllTools(false)}
            >
              Disable All
            </button>
            <button style={styles.btn} disabled={configLoading} onClick={loadConfig}>
              Reload Config
            </button>
            <button
              style={{ ...styles.btnPrimary, opacity: configSaving || !configDirty ? 0.5 : 1 }}
              disabled={configSaving || !configDirty}
              onClick={handleConfigSave}
            >
              {configSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>

        {toolsCatalogError && (
          <div style={styles.calloutWarn}>Could not load runtime tool catalog.</div>
        )}
        {!configForm && (
          <div style={styles.calloutInfo}>Load the gateway config to adjust tool profiles.</div>
        )}
        {hasAgentAllow && (
          <div style={styles.calloutInfo}>
            This agent is using an explicit allowlist in config. Overrides are managed in Config
            tab.
          </div>
        )}
        {hasGlobalAllow && (
          <div style={styles.calloutInfo}>
            Global tools.allow is set. Agent cannot enable globally blocked tools.
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <div style={styles.agentKv}>
            <div style={styles.kvLabel}>Profile</div>
            <div style={styles.mono}>{profile}</div>
          </div>
          <div style={styles.agentKv}>
            <div style={styles.kvLabel}>Source</div>
            <div>{profileSource}</div>
          </div>
          {configDirty && (
            <div style={styles.agentKv}>
              <div style={styles.kvLabel}>Status</div>
              <div style={styles.mono}>unsaved</div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, marginBottom: 8, color: "var(--text-strong)" }}>
            Quick Presets
          </div>
          <div style={styles.buttonsRow}>
            {profileOptions.map((opt) => (
              <button
                key={opt.id}
                style={{ ...styles.btn, ...(profile === opt.id ? styles.btnActive : {}) }}
                disabled={!toolsEditable}
                onClick={() => handleProfileChange(opt.id, true)}
              >
                {opt.label}
              </button>
            ))}
            <button
              style={styles.btn}
              disabled={!toolsEditable}
              onClick={() => handleProfileChange(null, false)}
            >
              Inherit
            </button>
          </div>
        </div>

        <div style={styles.toolsGrid}>
          {sections.map((section) => (
            <div key={section.id} style={styles.toolSection}>
              <div style={styles.toolSectionHeader}>
                {section.label}
                {section.source === "plugin" && (
                  <span style={{ ...styles.mono, marginLeft: 6, color: "var(--muted)" }}>
                    plugin
                  </span>
                )}
              </div>
              <div>
                {section.tools.map((tool) => {
                  const { allowed } = resolveAllowed(tool.id);
                  const source =
                    tool.source === "plugin"
                      ? tool.pluginId
                        ? `plugin:${tool.pluginId}`
                        : "plugin"
                      : "core";
                  return (
                    <div key={tool.id} style={styles.toolRow}>
                      <div>
                        <div style={styles.toolTitle}>
                          {tool.label}
                          <span style={{ color: "var(--muted)", marginLeft: 8, fontWeight: 400 }}>
                            {source}
                          </span>
                          {tool.optional && (
                            <span style={{ color: "var(--muted)", marginLeft: 6, fontWeight: 400 }}>
                              optional
                            </span>
                          )}
                        </div>
                        <div style={styles.toolSub}>{tool.description}</div>
                      </div>
                      <Toggle
                        checked={allowed}
                        disabled={!toolsEditable}
                        onChange={(checked) => updateTool(tool.id, checked)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {toolsCatalogLoading && (
          <div style={{ ...styles.cardSub, marginTop: 10 }}>Refreshing tool catalog...</div>
        )}
      </section>

      {/* Skills Section */}
      <section style={styles.card}>
        <div style={styles.row}>
          <div>
            <div style={styles.cardTitle}>Skills</div>
            <div style={styles.cardSub}>
              Per-agent skill allowlist and workspace skills.{" "}
              {rawSkills.length > 0 && (
                <span style={styles.mono}>
                  {skillsEnabledCount}/{rawSkills.length}
                </span>
              )}
            </div>
          </div>
          <div style={styles.buttonsRow}>
            <button style={styles.btn} disabled={!toolsEditable} onClick={handleSkillClear}>
              Use All
            </button>
            <button style={styles.btn} disabled={!toolsEditable} onClick={handleSkillDisableAll}>
              Disable All
            </button>
            <button style={styles.btn} disabled={configLoading} onClick={loadConfig}>
              Reload Config
            </button>
            <button style={styles.btn} disabled={skillsLoading} onClick={loadSkills}>
              {skillsLoading ? "Loading..." : "Refresh"}
            </button>
            <button
              style={{ ...styles.btnPrimary, opacity: configSaving || !configDirty ? 0.5 : 1 }}
              disabled={configSaving || !configDirty}
              onClick={handleConfigSave}
            >
              {configSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>

        {!configForm && (
          <div style={styles.calloutInfo}>Load the gateway config to set per-agent skills.</div>
        )}
        {usingAllowlist ? (
          <div style={styles.calloutInfo}>This agent uses a custom skill allowlist.</div>
        ) : (
          <div style={styles.calloutInfo}>
            All skills are enabled. Disabling any skill will create a per-agent allowlist.
          </div>
        )}
        {skillsError && <div style={styles.calloutWarn}>{skillsError}</div>}

        <div style={{ marginTop: 14 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}>
            <span style={{ fontSize: 12, color: "var(--text-strong)", fontWeight: 500 }}>
              Filter
            </span>
            <input
              style={{
                padding: "8px 12px",
                borderRadius: "var(--radius-md)",
                borderWidth: 1,
                borderStyle: "solid",
                borderColor: "var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                fontSize: 13,
                outline: "none",
              }}
              value={skillsFilter}
              onChange={(e) => setSkillsFilter(e.target.value)}
              placeholder="Search skills"
            />
          </label>
        </div>

        {filteredSkills.length === 0 ? (
          <div style={{ ...styles.cardSub, marginTop: 16 }}>No skills found.</div>
        ) : (
          <div style={{ marginTop: 16 }}>
            <div style={styles.toolSection}>
              <div style={styles.toolSectionHeader}>Matched Skills ({filteredSkills.length})</div>
              <div>
                {filteredSkills.map((skill) => {
                  const enabled = usingAllowlist ? allowSet.has(skill.name) : true;
                  return (
                    <div key={skill.name} style={styles.toolRow}>
                      <div>
                        <div style={styles.toolTitle}>
                          {skill.emoji ? `${skill.emoji} ` : ""}
                          {skill.name}
                        </div>
                        <div style={styles.toolSub}>{skill.description}</div>
                      </div>
                      <Toggle
                        checked={enabled}
                        disabled={!toolsEditable}
                        onChange={(checked) => handleSkillToggle(skill.name, checked)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
