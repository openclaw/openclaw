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
      "Removed blank agents.entries.main.workspace; the default workspace directory applies.",
    ]);
  });

  it("removes a blank defaults workspace", () => {
    const raw: Record<string, unknown> = {
      agents: { defaults: { model: "openai/gpt-5.6", workspace: "  " } },
    };
    const changes: string[] = [];

    migration.apply(raw, changes);

    expect(raw).toEqual({ agents: { defaults: { model: "openai/gpt-5.6" } } });
    expect(changes).toEqual(["Removed blank agents.defaults.workspace."]);
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

  it("removes a residual legacy-list blank even when keyed entries exist (same traversal as runtime)", () => {
    // Doctor previously visited only the keyed entries map and early-returned,
    // skipping a residual agents.list; the runtime migration removes both. The
    // shared transform makes Doctor and runtime agree on the same traversal.
    const raw: Record<string, unknown> = {
      agents: {
        entries: { main: { model: "openai/gpt-5.6", workspace: " " } },
        list: [{ id: "legacy", workspace: "" }],
      },
    };
    const changes: string[] = [];

    migration.apply(raw, changes);

    expect(raw).toEqual({
      agents: { entries: { main: { model: "openai/gpt-5.6" } }, list: [{ id: "legacy" }] },
    });
    expect(changes).toEqual([
      "Removed blank agents.entries.main.workspace; the default workspace directory applies.",
      "Removed blank agents.list[0].workspace; the default workspace directory applies.",
    ]);
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
