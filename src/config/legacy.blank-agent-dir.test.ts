import { describe, expect, it } from "vitest";
import { migrateBlankAgentDir, migrateBlankAgentDirForWrite } from "./legacy.blank-agent-dir.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("legacy blank agent agentDir migration", () => {
  it("removes a blank per-agent agentDir and reports the change", () => {
    const raw = {
      agents: {
        entries: { alpha: { agentDir: " " } },
      },
    };
    const migrated = migrateBlankAgentDir(raw);
    expect(migrated.changed).toBe(true);
    const config = migrated.config as OpenClawConfig;
    expect(config.agents?.entries?.alpha).not.toHaveProperty("agentDir");
    expect(migrated.changes.some((c) => c.path === "entries.alpha")).toBe(true);
  });

  it("removes blank agentDir values from agents.list entries", () => {
    const raw = {
      agents: {
        list: [{ id: "alpha", agentDir: "   " }, { id: "beta" }],
      },
    };
    const migrated = migrateBlankAgentDir(raw);
    expect(migrated.changed).toBe(true);
    const config = migrated.config as OpenClawConfig;
    const list = config.agents?.list;
    expect(list).toHaveLength(2);
    expect(list?.[0]).not.toHaveProperty("agentDir");
    expect(list?.[1]).not.toHaveProperty("agentDir");
  });

  it("reports list entry removals with the writer's dot-notation path", () => {
    const raw = {
      agents: {
        list: [{ id: "alpha", agentDir: " " }],
      },
    };
    const migrated = migrateBlankAgentDir(raw);
    expect(migrated.changes.some((c) => c.path === "list.0")).toBe(true);
    expect(migrated.changes.some((c) => c.message.includes("agents.list.0.agentDir"))).toBe(true);
  });

  it("preserves a blank agents.list entry that the current write explicitly sets", () => {
    const raw = {
      agents: {
        list: [{ id: "alpha", agentDir: "" }],
      },
    };
    // The writer joins explicit path segments with dots; an explicitly written
    // blank list value must keep the strict field error instead of being
    // silently migrated away.
    const explicitSetPaths = new Set(["agents.list.0.agentDir"]);
    const migrated = migrateBlankAgentDirForWrite(raw, explicitSetPaths);
    expect(migrated.changed).toBe(false);
    const config = migrated.config as OpenClawConfig;
    expect(config.agents?.list?.[0]).toHaveProperty("agentDir");
  });

  it("preserves non-blank agentDir values and unchanged configs", () => {
    const raw = { agents: { entries: { alpha: { agentDir: "/srv/alpha" } } } };
    const migrated = migrateBlankAgentDir(raw);
    expect(migrated.changed).toBe(false);
    expect(migrated.config).toBe(raw);
    const noAgents = migrateBlankAgentDir({ cron: {} });
    expect(noAgents.changed).toBe(false);
  });

  it("does not treat a non-string agentDir as blank", () => {
    const raw = { agents: { entries: { alpha: { agentDir: 42 } } } };
    const migrated = migrateBlankAgentDir(raw);
    expect(migrated.changed).toBe(false);
  });
});
