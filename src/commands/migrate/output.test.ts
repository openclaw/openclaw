import { describe, expect, it } from "vitest";
import type { MigrationItem, MigrationPlan } from "../../plugins/types.js";
import { stripAnsi } from "../../terminal/ansi.js";
import { formatMigrationPreview, formatMigrationResult } from "./output.js";

function skillItem(index: number): MigrationItem {
  return {
    id: `skill:skill-${index}`,
    kind: "skill",
    action: "copy",
    status: "planned",
    details: {
      skillName: `skill-${index}`,
    },
  };
}

function pluginItem(name: string): MigrationItem {
  return {
    id: `plugin:${name}`,
    kind: "plugin",
    action: "install",
    status: "planned",
    details: {
      configKey: name,
      marketplaceName: "openai-curated",
      pluginName: name,
    },
  };
}

function configItem(): MigrationItem {
  return {
    id: "config:codex-plugins-root",
    kind: "config",
    action: "update",
    status: "planned",
  };
}

function plan(items: MigrationItem[]): MigrationPlan {
  return {
    providerId: "codex",
    source: "/tmp/codex",
    summary: {
      total: items.length,
      planned: items.length,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items,
  };
}

describe("formatMigrationPreview", () => {
  it("groups items under per-kind headings", () => {
    const output = formatMigrationPreview(
      plan([skillItem(1), pluginItem("google-calendar"), pluginItem("gmail")]),
    )
      .map(stripAnsi)
      .join("\n");

    expect(output).toContain("Skills:");
    expect(output).toContain("Plugins:");
    expect(output).not.toContain("Native Codex plugins:");
    expect(output).toContain("• skill-1");
    expect(output).toContain("• google-calendar");
    expect(output).toContain("• gmail");
  });

  it("hides config items from display and excludes them from the count", () => {
    const output = formatMigrationPreview(plan([skillItem(1), configItem()]))
      .map(stripAnsi)
      .join("\n");

    expect(output).toContain("1 item, 0 conflicts, 0 sensitive items");
    expect(output).not.toContain("Config:");
    expect(output).not.toContain("codex-plugins-root");
  });
});

describe("formatMigrationResult", () => {
  it("renders a check glyph and (Migrated) for migrated items", () => {
    const output = formatMigrationResult(plan([{ ...skillItem(1), status: "migrated" }]))
      .map(stripAnsi)
      .join("\n");

    expect(output).toContain("✅");
    expect(output).toContain("(Migrated)");
  });

  it("humanizes known error reason codes", () => {
    const output = formatMigrationResult(
      plan([{ ...pluginItem("google-calendar"), status: "error", reason: "plugin_missing" }]),
    )
      .map(stripAnsi)
      .join("\n");

    expect(output).toContain("❌");
    expect(output).toContain("Plugin not found in the Codex marketplace");
  });

  it("says (Skipped) for user-deselected skill/plugin items", () => {
    const output = formatMigrationResult(
      plan([{ ...skillItem(1), status: "skipped", reason: "not selected for migration" }]),
    )
      .map(stripAnsi)
      .join("\n");

    expect(output).toContain("(Skipped)");
  });
});
