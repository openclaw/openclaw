import { describe, it, expect } from "vitest";
import {
  deriveAllowAgents,
  buildConfigEntryFromManifest,
  detectDrift,
  applySync,
  type ConfigAgentEntry,
} from "./agent-config-sync.js";
import type { AgentManifest } from "./zod-schema.agent-manifest.js";

// ── Test fixtures ──────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<AgentManifest> & { id: string }): AgentManifest {
  return {
    name: overrides.id,
    tier: 3,
    role: "Test Agent",
    department: "engineering",
    description: "A test agent",
    version: "1.0.0",
    ...overrides,
  } as AgentManifest;
}

const operator1 = makeManifest({
  id: "operator1",
  name: "Operator1",
  tier: 1,
  department: "core",
  role: "Core Orchestrator",
});
const neo = makeManifest({
  id: "neo",
  name: "Neo",
  tier: 2,
  department: "engineering",
  role: "VP Engineering",
});
const trinity = makeManifest({
  id: "trinity",
  name: "Trinity",
  tier: 2,
  department: "finance",
  role: "CFO",
});
const tank = makeManifest({
  id: "tank",
  name: "Tank",
  tier: 3,
  department: "engineering",
  role: "DevOps Lead",
  requires: "neo",
});
const spark = makeManifest({
  id: "spark",
  name: "Spark",
  tier: 3,
  department: "engineering",
  role: "Frontend Dev",
  requires: "neo",
});
const ledger = makeManifest({
  id: "ledger",
  name: "Ledger",
  tier: 3,
  department: "finance",
  role: "Bookkeeper",
  requires: "trinity",
});

const allManifests = [operator1, neo, trinity, tank, spark, ledger];

// ── deriveAllowAgents ──────────────────────────────────────────────────────

describe("deriveAllowAgents", () => {
  it("T1 agents get all T2 and T3 agents", () => {
    const result = deriveAllowAgents(allManifests);
    const op1Allow = result.get("operator1")!;
    expect(op1Allow).toContain("neo");
    expect(op1Allow).toContain("trinity");
    expect(op1Allow).toContain("tank");
    expect(op1Allow).toContain("spark");
    expect(op1Allow).toContain("ledger");
    expect(op1Allow).toHaveLength(5);
  });

  it("T2 agents get only their T3 children", () => {
    const result = deriveAllowAgents(allManifests);
    expect(result.get("neo")).toEqual(expect.arrayContaining(["tank", "spark"]));
    expect(result.get("neo")).toHaveLength(2);
    expect(result.get("trinity")).toEqual(["ledger"]);
  });

  it("T3 agents get empty allowAgents", () => {
    const result = deriveAllowAgents(allManifests);
    expect(result.get("tank")).toEqual([]);
    expect(result.get("spark")).toEqual([]);
    expect(result.get("ledger")).toEqual([]);
  });

  it("filters out bundles", () => {
    const bundle = makeManifest({
      id: "eng-pack",
      name: "Eng Pack",
      tier: 2,
      is_bundle: true,
      bundle_agents: ["neo", "tank"],
    });
    const result = deriveAllowAgents([...allManifests, bundle]);
    expect(result.has("eng-pack")).toBe(false);
  });

  it("handles empty input", () => {
    const result = deriveAllowAgents([]);
    expect(result.size).toBe(0);
  });
});

// ── buildConfigEntryFromManifest ───────────────────────────────────────────

describe("buildConfigEntryFromManifest", () => {
  it("creates config entry from manifest", () => {
    const entry = buildConfigEntryFromManifest(neo, ["tank", "spark"]);
    expect(entry.id).toBe("neo");
    expect(entry.name).toBe("Neo");
    expect(entry.department).toBe("engineering");
    expect(entry.role).toBe("VP Engineering");
    expect(entry.subagents?.allowAgents).toEqual(["tank", "spark"]);
  });

  it("preserves existing runtime fields", () => {
    const existing: ConfigAgentEntry = {
      id: "neo",
      workspace: "/custom/workspace",
      model: { primary: "claude-opus-4-6" },
      identity: { emoji: "🤖", theme: "dark" },
      customField: "preserved",
    };
    const entry = buildConfigEntryFromManifest(neo, ["tank"], existing);
    expect(entry.workspace).toBe("/custom/workspace");
    expect(entry.model).toEqual({ primary: "claude-opus-4-6" });
    expect(entry.identity).toEqual({ emoji: "🤖", theme: "dark" });
    expect(entry.customField).toBe("preserved");
    expect(entry.name).toBe("Neo");
    expect(entry.subagents?.allowAgents).toEqual(["tank"]);
  });

  it("preserves subagent model/thinking when updating allowAgents", () => {
    const existing: ConfigAgentEntry = {
      id: "neo",
      subagents: { allowAgents: ["old-agent"], model: "claude-sonnet-4-6", thinking: "low" },
    };
    const entry = buildConfigEntryFromManifest(neo, ["tank", "spark"], existing);
    expect(entry.subagents?.allowAgents).toEqual(["tank", "spark"]);
    expect(entry.subagents?.model).toBe("claude-sonnet-4-6");
    expect(entry.subagents?.thinking).toBe("low");
  });

  it("clears allowAgents for T3 but preserves other subagent fields", () => {
    const existing: ConfigAgentEntry = {
      id: "tank",
      subagents: { allowAgents: ["stale"], model: "claude-sonnet-4-6" },
    };
    const entry = buildConfigEntryFromManifest(tank, [], existing);
    expect(entry.subagents?.allowAgents).toBeUndefined();
    expect(entry.subagents?.model).toBe("claude-sonnet-4-6");
  });

  it("syncs identity.emoji from manifest", () => {
    const neoWithEmoji = makeManifest({
      id: "neo",
      name: "Neo",
      tier: 2,
      department: "engineering",
      role: "VP Engineering",
      identity: { emoji: "🔮" },
    });
    const entry = buildConfigEntryFromManifest(neoWithEmoji, ["tank", "spark"]);
    expect(entry.identity?.emoji).toBe("🔮");
  });

  it("manifest identity.emoji overrides existing identity.emoji but preserves other identity fields", () => {
    const neoWithEmoji = makeManifest({
      id: "neo",
      name: "Neo",
      tier: 2,
      department: "engineering",
      role: "VP Engineering",
      identity: { emoji: "🔮" },
    });
    const existing: ConfigAgentEntry = {
      id: "neo",
      identity: { emoji: "🤖", theme: "dark", avatar: "https://example.com/neo.png" },
    };
    const entry = buildConfigEntryFromManifest(neoWithEmoji, ["tank"], existing);
    expect(entry.identity?.emoji).toBe("🔮");
    expect(entry.identity?.theme).toBe("dark");
    expect(entry.identity?.avatar).toBe("https://example.com/neo.png");
  });

  it("preserves existing identity when manifest has no identity", () => {
    const existing: ConfigAgentEntry = {
      id: "neo",
      identity: { emoji: "🤖", theme: "dark" },
    };
    const entry = buildConfigEntryFromManifest(neo, ["tank"], existing);
    expect(entry.identity?.emoji).toBe("🤖");
    expect(entry.identity?.theme).toBe("dark");
  });

  it("removes subagents entirely if empty after clearing allowAgents", () => {
    const existing: ConfigAgentEntry = {
      id: "tank",
      subagents: { allowAgents: ["stale"] },
    };
    const entry = buildConfigEntryFromManifest(tank, [], existing);
    expect(entry.subagents).toBeUndefined();
  });
});

// ── detectDrift ────────────────────────────────────────────────────────────

describe("detectDrift", () => {
  const derived = deriveAllowAgents(allManifests);

  it("reports no drift when config matches manifests", () => {
    const configEntries: ConfigAgentEntry[] = [
      {
        id: "main",
        name: "Operator1",
        department: "core",
        role: "Core Orchestrator",
        subagents: { allowAgents: ["neo", "trinity", "tank", "spark", "ledger"] },
      },
      {
        id: "neo",
        name: "Neo",
        department: "engineering",
        role: "VP Engineering",
        subagents: { allowAgents: ["tank", "spark"] },
      },
      {
        id: "trinity",
        name: "Trinity",
        department: "finance",
        role: "CFO",
        subagents: { allowAgents: ["ledger"] },
      },
      { id: "tank", name: "Tank", department: "engineering", role: "DevOps Lead" },
      { id: "spark", name: "Spark", department: "engineering", role: "Frontend Dev" },
      { id: "ledger", name: "Ledger", department: "finance", role: "Bookkeeper" },
    ];
    const report = detectDrift(allManifests, configEntries, derived);
    expect(report.hasDrift).toBe(false);
    expect(report.issues).toHaveLength(0);
  });

  it("detects missing config entries", () => {
    const configEntries: ConfigAgentEntry[] = [
      {
        id: "main",
        name: "Operator1",
        department: "core",
        role: "Core Orchestrator",
        subagents: { allowAgents: ["neo", "trinity", "tank", "spark", "ledger"] },
      },
      {
        id: "neo",
        name: "Neo",
        department: "engineering",
        role: "VP Engineering",
        subagents: { allowAgents: ["tank", "spark"] },
      },
    ];
    const report = detectDrift(allManifests, configEntries, derived);
    expect(report.hasDrift).toBe(true);
    expect(report.missingInConfig).toContain("trinity");
    expect(report.missingInConfig).toContain("tank");
    expect(report.missingInConfig).toContain("spark");
    expect(report.missingInConfig).toContain("ledger");
  });

  it("detects orphaned config entries", () => {
    const configEntries: ConfigAgentEntry[] = [
      { id: "main", name: "Operator1" },
      { id: "neo", name: "Neo" },
      { id: "ghost-agent", name: "Ghost" },
    ];
    const report = detectDrift(allManifests, configEntries, derived);
    expect(report.orphanedInConfig).toContain("ghost-agent");
  });

  it("detects department mismatch", () => {
    const configEntries: ConfigAgentEntry[] = [
      { id: "main" },
      { id: "neo", department: "marketing", role: "VP Engineering", name: "Neo" },
      { id: "trinity" },
      { id: "tank" },
      { id: "spark" },
      { id: "ledger" },
    ];
    const report = detectDrift(allManifests, configEntries, derived);
    const deptIssue = report.issues.find(
      (i) => i.type === "department_mismatch" && i.agentId === "neo",
    );
    expect(deptIssue).toBeDefined();
    expect(deptIssue!.expected).toBe("engineering");
    expect(deptIssue!.actual).toBe("marketing");
  });

  it("detects incomplete allowAgents", () => {
    const configEntries: ConfigAgentEntry[] = [
      { id: "main", subagents: { allowAgents: ["neo"] } },
      {
        id: "neo",
        name: "Neo",
        department: "engineering",
        role: "VP Engineering",
        subagents: { allowAgents: ["tank"] },
      },
      { id: "trinity", name: "Trinity", department: "finance", role: "CFO" },
      { id: "tank" },
      { id: "spark" },
      { id: "ledger" },
    ];
    const report = detectDrift(allManifests, configEntries, derived);
    const neoAllow = report.issues.find(
      (i) => i.type === "allow_agents_incomplete" && i.agentId === "neo",
    );
    expect(neoAllow).toBeDefined();
    expect(neoAllow!.message).toContain("spark");
  });

  it("maps operator1 to main in config lookup", () => {
    const configEntries: ConfigAgentEntry[] = [
      {
        id: "main",
        name: "Operator1",
        department: "core",
        role: "Core Orchestrator",
        subagents: { allowAgents: ["neo", "trinity", "tank", "spark", "ledger"] },
      },
      {
        id: "neo",
        name: "Neo",
        department: "engineering",
        role: "VP Engineering",
        subagents: { allowAgents: ["tank", "spark"] },
      },
      {
        id: "trinity",
        name: "Trinity",
        department: "finance",
        role: "CFO",
        subagents: { allowAgents: ["ledger"] },
      },
      { id: "tank" },
      { id: "spark" },
      { id: "ledger" },
    ];
    const report = detectDrift(allManifests, configEntries, derived);
    expect(report.missingInConfig).not.toContain("operator1");
  });
});

// ── applySync ──────────────────────────────────────────────────────────────

describe("applySync", () => {
  it("adds missing config entries", () => {
    const configEntries: ConfigAgentEntry[] = [
      { id: "main", name: "Operator1" },
      { id: "neo", name: "Neo" },
    ];
    const derived = deriveAllowAgents(allManifests);
    const drift = detectDrift(allManifests, configEntries, derived);
    const synced = applySync(allManifests, configEntries, drift);

    expect(synced.length).toBeGreaterThan(configEntries.length);
    const trinityEntry = synced.find((e) => e.id === "trinity");
    expect(trinityEntry).toBeDefined();
    expect(trinityEntry!.department).toBe("finance");
    expect(trinityEntry!.role).toBe("CFO");
  });

  it("updates mismatched fields in existing entries", () => {
    const configEntries: ConfigAgentEntry[] = [
      { id: "main" },
      {
        id: "neo",
        name: "Wrong Name",
        department: "wrong-dept",
        role: "Wrong Role",
        workspace: "/keep-this",
      },
      { id: "trinity" },
      { id: "tank" },
      { id: "spark" },
      { id: "ledger" },
    ];
    const derived = deriveAllowAgents(allManifests);
    const drift = detectDrift(allManifests, configEntries, derived);
    const synced = applySync(allManifests, configEntries, drift);

    const neoEntry = synced.find((e) => e.id === "neo")!;
    expect(neoEntry.name).toBe("Neo");
    expect(neoEntry.department).toBe("engineering");
    expect(neoEntry.role).toBe("VP Engineering");
    expect(neoEntry.workspace).toBe("/keep-this");
  });

  it("does not remove orphaned config entries", () => {
    const configEntries: ConfigAgentEntry[] = [
      { id: "main" },
      { id: "neo" },
      { id: "trinity" },
      { id: "tank" },
      { id: "spark" },
      { id: "ledger" },
      { id: "ghost", name: "Ghost Agent" },
    ];
    const derived = deriveAllowAgents(allManifests);
    const drift = detectDrift(allManifests, configEntries, derived);
    const synced = applySync(allManifests, configEntries, drift);

    expect(synced.find((e) => e.id === "ghost")).toBeDefined();
  });

  it("rebuilds allowAgents from tier hierarchy", () => {
    const configEntries: ConfigAgentEntry[] = [
      { id: "main" },
      { id: "neo" },
      { id: "trinity" },
      { id: "tank" },
      { id: "spark" },
      { id: "ledger" },
    ];
    const derived = deriveAllowAgents(allManifests);
    const drift = detectDrift(allManifests, configEntries, derived);
    const synced = applySync(allManifests, configEntries, drift);

    const mainEntry = synced.find((e) => e.id === "main")!;
    expect(mainEntry.subagents?.allowAgents).toContain("neo");
    expect(mainEntry.subagents?.allowAgents).toContain("trinity");

    const neoEntry = synced.find((e) => e.id === "neo")!;
    expect(neoEntry.subagents?.allowAgents).toEqual(expect.arrayContaining(["tank", "spark"]));
    expect(neoEntry.subagents?.allowAgents).toHaveLength(2);
  });

  it("uses operator1→main ID mapping in sync output", () => {
    const configEntries: ConfigAgentEntry[] = [];
    const derived = deriveAllowAgents(allManifests);
    const drift = detectDrift(allManifests, configEntries, derived);
    const synced = applySync(allManifests, configEntries, drift);

    const mainEntry = synced.find((e) => e.id === "main");
    expect(mainEntry).toBeDefined();
    expect(synced.find((e) => e.id === "operator1")).toBeUndefined();
  });
});
