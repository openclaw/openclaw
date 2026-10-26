import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import {
  createMigrationConfigPatchItem,
  summarizeMigrationItems,
} from "../../plugin-sdk/migration.js";
import type { MigrationItem, MigrationPlan } from "../../plugins/types.js";
import { formatMigrationPreview, formatMigrationResult } from "./output.js";

function item(kind: "skill" | "plugin", overrides: Partial<MigrationItem> = {}): MigrationItem {
  return {
    id: kind === "skill" ? "skill:skill-1" : "plugin:google-calendar",
    kind,
    action: kind === "skill" ? "copy" : "install",
    status: "planned",
    ...overrides,
  };
}

const fakeSecret = (label: string) => ["sk", label, "secret", "12345678"].join("-");

function renderer(format: (plan: MigrationPlan) => string[]) {
  return (items: MigrationItem[], extra: Partial<MigrationPlan> = {}) =>
    format({
      providerId: "codex",
      source: "/tmp/codex",
      summary: summarizeMigrationItems(items),
      items,
      ...extra,
    })
      .map(stripAnsi)
      .join("\n");
}
const preview = renderer(formatMigrationPreview);
const result = renderer(formatMigrationResult);
const nextStep = "Run openclaw doctor after applying the migration.";

function expectText(output: string, ...parts: string[]) {
  for (const part of parts) {
    expect(output).toContain(part);
  }
}

describe("formatMigrationPreview", () => {
  it("groups items under per-kind headings", () => {
    const output = preview([item("skill"), item("plugin"), item("plugin", { id: "plugin:gmail" })]);
    expectText(output, "Skills:", "Plugins:", "• skill-1", "• google-calendar", "• gmail");
    expect(output).not.toContain("Native Codex plugins:");
  });

  it.each([false, true])("redacts sensitive config values (conflict: %s)", (conflict) => {
    const hiddenValueOne = fakeSecret("config-preview");
    const hiddenValueTwo = fakeSecret("config-argument");
    const output = preview([
      ...(conflict ? [item("skill")] : []),
      createMigrationConfigPatchItem({
        id: "config:codex-plugins-root",
        target: "plugins.entries.codex.config.codexPlugins",
        path: ["plugins", "entries", "codex", "config", "codexPlugins"],
        message: "Update the Codex plugin configuration.",
        conflict,
        sensitive: true,
        value: { first: hiddenValueOne, args: ["--value", hiddenValueTwo] },
      }),
    ]);
    expectText(
      output,
      conflict ? "2 items, 1 conflict, 1 sensitive item" : "1 item, 0 conflicts, 1 sensitive item",
      "Config:",
      "codex-plugins-root [sensitive]",
    );
    expect(output).not.toContain(hiddenValueOne);
    expect(output).not.toContain(hiddenValueTwo);
  });
});

describe("formatMigrationResult", () => {
  it.each([false, true])("renders provider warnings once (also a next step: %s)", (shared) => {
    const warning = "Some imported settings require manual review before activation.";
    const output = result(
      [item(shared ? "plugin" : "skill", { status: shared ? "warning" : "migrated" })],
      {
        warnings: [warning],
        nextSteps: shared ? [warning, nextStep] : [nextStep],
      },
    );
    expectText(output, `⚠️  ${warning}`, `• ${nextStep}`);
    expect(output.includes("Warnings:")).toBe(!shared);
    expect(output.split(warning)).toHaveLength(2);
  });

  it("says (Skipped) for user-deselected skill/plugin items", () => {
    const output = result([
      item("skill", { status: "skipped", reason: "not selected for migration" }),
    ]);
    expect(output).toContain("(Skipped)");
  });
});

it.each([
  { format: preview, mode: "preview", status: "error", field: "reason" },
  { format: result, mode: "result", status: "warning", field: "message" },
] as const)(
  "redacts $mode item text, warnings, and next steps",
  ({ format, mode, status, field }) => {
    const secret = fakeSecret(mode);
    const message = `Provider returned ${mode === "result" ? "Bearer " : ""}${secret}`;
    const output = format([item("plugin", { status, [field]: message })], {
      warnings: [`Retry with Bearer ${secret}`],
      nextSteps: [`Save ${secret} for retry`],
    });
    expect(output).not.toContain(secret);
    expectText(output, "Retry with [redacted]", "[redacted]");
  },
);
