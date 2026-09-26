import { describe, expect, it } from "vitest";
import { migrateBlankAgentWorkspace } from "./legacy.blank-agent-workspace.js";

describe("runtime blank agent workspace migration", () => {
  it.each(["", "   ", "\t\n "])("removes a blank per-agent workspace %j", (workspace) => {
    const result = migrateBlankAgentWorkspace({
      agents: { entries: { main: { model: "openai/gpt-5.6", workspace } } },
    });

    expect(result.changed).toBe(true);
    expect(result.config).toEqual({
      agents: { entries: { main: { model: "openai/gpt-5.6" } } },
    });
    expect(result.changes).toEqual([
      {
        path: "entries.main",
        message:
          "Removed blank agents.entries.main.workspace; the default workspace directory applies.",
      },
    ]);
  });

  it("removes a blank defaults workspace", () => {
    const result = migrateBlankAgentWorkspace({
      agents: { defaults: { model: "openai/gpt-5.6", workspace: "  " } },
    });

    expect(result.changed).toBe(true);
    expect(result.config).toEqual({ agents: { defaults: { model: "openai/gpt-5.6" } } });
    expect(result.changes).toEqual([
      { path: "agents.defaults.workspace", message: "Removed blank agents.defaults.workspace." },
    ]);
  });

  it("removes a blank workspace from a legacy list entry", () => {
    const result = migrateBlankAgentWorkspace({
      agents: { list: [{ id: "alpha" }, { id: "beta", workspace: " " }] },
    });

    expect(result.changed).toBe(true);
    expect(result.config).toEqual({ agents: { list: [{ id: "alpha" }, { id: "beta" }] } });
    expect(result.changes).toEqual([
      {
        path: "list[1]",
        message: "Removed blank agents.list[1].workspace; the default workspace directory applies.",
      },
    ]);
  });

  it("preserves a non-blank workspace", () => {
    const result = migrateBlankAgentWorkspace({
      agents: { entries: { main: { workspace: "/srv/main" } } },
    });

    expect(result.changed).toBe(false);
    expect(result.config).toEqual({ agents: { entries: { main: { workspace: "/srv/main" } } } });
    expect(result.changes).toEqual([]);
  });

  it("leaves config without a workspace unchanged", () => {
    const result = migrateBlankAgentWorkspace({
      agents: { defaults: { model: "openai/gpt-5.6" } },
    });

    expect(result.changed).toBe(false);
    expect(result.config).toEqual({ agents: { defaults: { model: "openai/gpt-5.6" } } });
    expect(result.changes).toEqual([]);
  });

  it("does not structurally change the input object", () => {
    const raw = { agents: { entries: { main: { workspace: " " } } } };
    migrateBlankAgentWorkspace(raw);

    // The migration clones before mutating so callers keep an untouched authored copy.
    expect(raw).toEqual({ agents: { entries: { main: { workspace: " " } } } });
  });
});
