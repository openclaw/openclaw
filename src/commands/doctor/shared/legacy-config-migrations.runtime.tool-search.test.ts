import { describe, expect, it } from "vitest";
import { resolveToolSearchConfig } from "../../../agents/tool-search-config.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

describe("Tool Search structured config migration", () => {
  it("detects and retires code mode while preserving activation and search limits", () => {
    const raw = {
      tools: {
        toolSearch: {
          enabled: false,
          mode: "code",
          codeTimeoutMs: 2500,
          searchDefaultLimit: 4,
          maxSearchLimit: 12,
        },
      },
    };
    const original = structuredClone(raw);

    expect(findLegacyConfigIssues(raw)).toEqual([
      {
        path: "tools.toolSearch.mode",
        message:
          'Tool Search code mode (tool_search_code) is retired; use structured Tool Search. Run "openclaw doctor --fix".',
      },
      {
        path: "tools.toolSearch.codeTimeoutMs",
        message: 'tools.toolSearch.codeTimeoutMs is retired. Run "openclaw doctor --fix".',
      },
    ]);

    const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });

    expect(migrated.partiallyValid).toBeUndefined();
    expect(migrated.config?.tools?.toolSearch).toEqual({
      enabled: false,
      mode: "tools",
      searchDefaultLimit: 4,
      maxSearchLimit: 12,
    });
    expect(migrated.changes).toEqual([
      "Tool Search code mode (tool_search_code) is retired; using structured Tool Search.",
      "Removed tools.toolSearch.codeTimeoutMs; Tool Search no longer executes code.",
    ]);
    expect(raw).toEqual(original);
    expect(migrated.sourceConfig).toBeDefined();
    expect(findLegacyConfigIssues(migrated.sourceConfig)).toEqual([]);
    expect(
      migrateLegacyConfig(migrated.sourceConfig, {
        sourceConfigBeforeMigrations: migrated.sourceConfig,
      }).changes,
    ).toEqual([]);
  });

  it.each([
    { input: { codeTimeoutMs: 2500 }, expected: { enabled: true }, enabled: true },
    { input: { codeTimeoutMs: null }, expected: { enabled: true }, enabled: true },
    {
      input: { codeTimeoutMs: 2500, enabled: null },
      expected: { enabled: true },
      enabled: true,
    },
    {
      input: { codeTimeoutMs: 2500, enabled: "invalid" },
      expected: { enabled: true },
      enabled: true,
    },
    {
      input: { codeTimeoutMs: 2500, enabled: false },
      expected: { enabled: false },
      enabled: false,
    },
    {
      input: { codeTimeoutMs: 2500, enabled: true },
      expected: { enabled: true },
      enabled: true,
    },
    {
      input: { codeTimeoutMs: 2500, searchDefaultLimit: 4 },
      expected: { searchDefaultLimit: 4 },
      enabled: true,
    },
    {
      input: { codeTimeoutMs: 2500, mode: "directory" },
      expected: { mode: "directory" },
      enabled: true,
    },
    { input: { mode: "code" }, expected: { mode: "tools" }, enabled: true },
  ])("preserves effective activation when retiring $input", ({ input, expected, enabled }) => {
    const raw = { tools: { toolSearch: input } };
    const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });

    expect(migrated.partiallyValid).toBeUndefined();
    expect(migrated.config?.tools?.toolSearch).toEqual(expected);
    expect(resolveToolSearchConfig(migrated.config ?? undefined).enabled).toBe(enabled);
    expect(findLegacyConfigIssues(migrated.sourceConfig)).toEqual([]);
  });

  it.each([
    undefined,
    true,
    false,
    {},
    { enabled: false },
    { mode: "tools" },
    { mode: "directory" },
  ])("leaves current settings %j untouched", (toolSearch) => {
    const raw = { tools: { toolSearch } };
    const original = structuredClone(raw);

    expect(findLegacyConfigIssues(raw)).toEqual([]);
    expect(migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw }).changes).toEqual([]);
    expect(raw).toEqual(original);
  });
});
