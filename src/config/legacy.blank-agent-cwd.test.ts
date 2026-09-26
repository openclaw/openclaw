import { describe, expect, it } from "vitest";
import { migrateBlankAgentCwd, migrateBlankAgentCwdForWrite } from "./legacy.blank-agent-cwd.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("legacy blank agent cwd migration", () => {
  it("removes a blank per-agent cwd and reports the change", () => {
    const raw = {
      agents: {
        defaults: { cwd: "/tmp/default" },
        entries: { alpha: { cwd: " " } },
      },
    };
    const migrated = migrateBlankAgentCwd(raw);
    expect(migrated.changed).toBe(true);
    const config = migrated.config as OpenClawConfig;
    expect(config.agents?.entries?.alpha).not.toHaveProperty("cwd");
    expect(config.agents?.defaults?.cwd).toBe("/tmp/default");
    expect(migrated.changes.some((c) => c.path === "entries.alpha")).toBe(true);
  });

  it("removes a blank defaults cwd when present", () => {
    const raw = { agents: { defaults: { cwd: " \t" } } };
    const migrated = migrateBlankAgentCwd(raw);
    expect(migrated.changed).toBe(true);
    const config = migrated.config as OpenClawConfig;
    expect(config.agents?.defaults).not.toHaveProperty("cwd");
    expect(migrated.changes.some((c) => c.path === "agents.defaults.cwd")).toBe(true);
  });

  it("removes blank cwd values from agents.list entries", () => {
    const raw = {
      agents: {
        defaults: { cwd: "/tmp/default" },
        list: [{ id: "alpha", cwd: "   " }, { id: "beta" }],
      },
    };
    const migrated = migrateBlankAgentCwd(raw);
    expect(migrated.changed).toBe(true);
    const config = migrated.config as OpenClawConfig;
    const list = config.agents?.list;
    expect(list).toHaveLength(2);
    expect(list?.[0]).not.toHaveProperty("cwd");
    expect(list?.[1]).not.toHaveProperty("cwd");
  });

  it("preserves non-blank cwd values and unchanged configs", () => {
    const raw = {
      agents: { defaults: { cwd: "/tmp/default" }, entries: { alpha: { cwd: "/srv/alpha" } } },
    };
    const migrated = migrateBlankAgentCwd(raw);
    expect(migrated.changed).toBe(false);
    expect(migrated.config).toBe(raw);
    const noAgents = migrateBlankAgentCwd({ cron: {} });
    expect(noAgents.changed).toBe(false);
  });

  it("does not treat a non-string cwd as blank", () => {
    const raw = { agents: { defaults: { cwd: 42 } } };
    const migrated = migrateBlankAgentCwd(raw);
    expect(migrated.changed).toBe(false);
  });

  it("reports list entry removals with the writer's dot-notation path", () => {
    // The write owner records explicit paths by joining segments with dots
    // (`agents.list.0.cwd`), so the migration must report (and preserve) that
    // representation, not the bracket form `agents.list[0].cwd`.
    const raw = {
      agents: { defaults: { cwd: "/tmp/default" }, list: [{ id: "alpha", cwd: " " }] },
    };
    const migrated = migrateBlankAgentCwdForWrite(raw);
    expect(migrated.changed).toBe(true);
    expect(migrated.changes.some((c) => c.path === "list.0")).toBe(true);
    expect(migrated.changes.some((c) => c.message.includes("agents.list.0.cwd"))).toBe(true);
  });

  it("preserves a blank agents.list entry that the current write explicitly sets", () => {
    // An explicit `agents.list.0.cwd` write is preserved (not migrated away) so
    // strict validation still reports the field-level error for new authoring.
    const raw = {
      agents: { defaults: { cwd: "/tmp/default" }, list: [{ id: "alpha", cwd: " " }] },
    };
    const migrated = migrateBlankAgentCwdForWrite(raw, new Set(["agents.list.0.cwd"]));
    expect(migrated.changed).toBe(false);
    const list = (migrated.config as OpenClawConfig).agents?.list;
    expect(list?.[0]).toMatchObject({ id: "alpha", cwd: " " });
  });
});
