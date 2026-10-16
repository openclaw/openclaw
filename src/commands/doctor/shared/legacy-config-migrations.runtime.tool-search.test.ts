import { describe, expect, it } from "vitest";
import { resolveToolSearchConfig } from "../../../agents/tool-search-config.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

describe("Tool Search structured config migration", () => {
  it.each([
    {
      input: {
        enabled: false,
        mode: "code",
        codeTimeoutMs: 2500,
        searchDefaultLimit: 4,
        maxSearchLimit: 12,
      },
      expected: { enabled: false, mode: "tools", searchDefaultLimit: 4, maxSearchLimit: 12 },
      enabled: false,
    },
    { input: { codeTimeoutMs: null }, expected: { enabled: true }, enabled: true },
    {
      input: { codeTimeoutMs: 2500, enabled: "invalid" },
      expected: { enabled: true },
      enabled: true,
    },
    {
      input: { codeTimeoutMs: 2500, searchDefaultLimit: 4 },
      expected: { searchDefaultLimit: 4 },
      enabled: true,
    },
    { input: { mode: "code" }, expected: { mode: "tools" }, enabled: true },
  ])("preserves activation and limits when retiring $input", ({ input, expected, enabled }) => {
    const raw = { tools: { toolSearch: input } };
    const original = structuredClone(raw);
    if (input.maxSearchLimit) {
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
    }
    const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(migrated.partiallyValid).toBeUndefined();
    expect(migrated.config?.tools?.toolSearch).toEqual(expected);
    expect(resolveToolSearchConfig(migrated.config ?? undefined).enabled).toBe(enabled);
    if (input.maxSearchLimit) {
      expect(migrated.changes).toEqual([
        "Tool Search code mode (tool_search_code) is retired; using structured Tool Search.",
        "Removed tools.toolSearch.codeTimeoutMs; Tool Search no longer executes code.",
      ]);
    }
    expect(raw).toEqual(original);
    expect(migrated.sourceConfig).toBeDefined();
    expect(findLegacyConfigIssues(migrated.sourceConfig)).toEqual([]);
    expect(
      migrateLegacyConfig(migrated.sourceConfig, {
        sourceConfigBeforeMigrations: migrated.sourceConfig,
      }).changes,
    ).toEqual([]);
  });
});
