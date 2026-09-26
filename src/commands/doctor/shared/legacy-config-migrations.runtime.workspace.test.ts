// Legacy migration tests: strict blank-workspace rejection preserves existing
// saved blank workspace values by removing them (falling back to each agent's
// established default workspace directory) instead of breaking the config.
import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { LEGACY_CONFIG_MIGRATION_RUNTIME_WORKSPACE } from "./legacy-config-migrations.runtime.workspace.js";

const migration = LEGACY_CONFIG_MIGRATION_RUNTIME_WORKSPACE;

describe("blank agent workspace migration", () => {
  it.each(["", "   ", "\t\n "])("removes a blank per-agent workspace %j", (workspace) => {
    const raw: Record<string, unknown> = {
      agents: { entries: { main: { model: "openai/gpt-5.6", workspace } } },
    };
    const changes: string[] = [];

    migration.apply(raw, changes);

    expect(raw).toEqual({ agents: { entries: { main: { model: "openai/gpt-5.6" } } } });
    expect(changes).toEqual([
      "Removed blank agents.entries.main.workspace; the agent keeps its default workspace directory.",
    ]);
  });

  it("removes a blank defaults workspace", () => {
    const raw: Record<string, unknown> = {
      agents: { defaults: { model: "openai/gpt-5.6", workspace: "  " } },
    };
    const changes: string[] = [];

    migration.apply(raw, changes);

    expect(raw).toEqual({ agents: { defaults: { model: "openai/gpt-5.6" } } });
    expect(changes).toEqual([
      "Removed blank agents.defaults.workspace; the agent keeps its default workspace directory.",
    ]);
  });

  it("preserves a non-blank workspace", () => {
    const raw: Record<string, unknown> = {
      agents: { entries: { main: { workspace: "/srv/main" } } },
    };
    const changes: string[] = [];

    migration.apply(raw, changes);

    expect(raw).toEqual({ agents: { entries: { main: { workspace: "/srv/main" } } } });
    expect(changes).toEqual([]);
  });

  it("leaves config without a workspace unchanged", () => {
    const raw: Record<string, unknown> = { agents: { defaults: { model: "openai/gpt-5.6" } } };
    const changes: string[] = [];

    migration.apply(raw, changes);

    expect(raw).toEqual({ agents: { defaults: { model: "openai/gpt-5.6" } } });
    expect(changes).toEqual([]);
  });
});

describe("blank agent workspace legacy detection", () => {
  it("detects a blank workspace inside the keyed agent entries map", () => {
    const issues = findLegacyConfigIssues(
      { agents: { entries: { alpha: { workspace: " " } } } },
      undefined,
      migration.legacyRules,
    );
    expect(issues.some((issue) => issue.message.includes("workspace values"))).toBe(true);
  });

  it("detects a blank workspace in the legacy agents.list form", () => {
    const issues = findLegacyConfigIssues(
      { agents: { list: [{ id: "main", workspace: "" }] } },
      undefined,
      migration.legacyRules,
    );
    expect(issues.some((issue) => issue.message.includes("workspace values"))).toBe(true);
  });

  it("does not report non-blank agent workspaces", () => {
    const issues = findLegacyConfigIssues(
      { agents: { entries: { alpha: { workspace: "/srv/alpha" } } } },
      undefined,
      migration.legacyRules,
    );
    expect(issues.some((issue) => issue.message.includes("workspace values"))).toBe(false);
  });
});
