import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import {
  createMigrationConfigPatchItem,
  summarizeMigrationItems,
} from "../../plugin-sdk/migration.js";
import type { MigrationItem, MigrationPlan } from "../../plugins/types.js";
import { formatMigrationPreview, formatMigrationResult } from "./output.js";

function item(
  kind: "skill" | "plugin",
  overrides: Partial<MigrationItem> = {},
  name = kind === "skill" ? "skill-1" : "google-calendar",
): MigrationItem {
  return {
    id: `${kind}:${name}`,
    kind,
    action: kind === "skill" ? "copy" : "install",
    status: "planned",
    ...overrides,
  };
}

function configItem(
  options: { conflict?: boolean; sensitive?: boolean; value?: unknown } = {},
): MigrationItem {
  return createMigrationConfigPatchItem({
    id: "config:codex-plugins-root",
    target: "plugins.entries.codex.config.codexPlugins",
    path: ["plugins", "entries", "codex", "config", "codexPlugins"],
    value: options.value ?? { enabled: true },
    message: "Update the Codex plugin configuration.",
    conflict: options.conflict,
    sensitive: options.sensitive,
  });
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
    const output = preview([item("skill"), item("plugin"), item("plugin", {}, "gmail")]);
    expectText(output, "Skills:", "Plugins:", "• skill-1", "• google-calendar", "• gmail");
    expect(output).not.toContain("Native Codex plugins:");
  });

  it("shows config conflicts in the preview header and config section", () => {
    const output = preview([item("skill"), configItem({ conflict: true, sensitive: true })]);
    expectText(output, "2 items, 1 conflict, 1 sensitive item", "Config:", "codex-plugins-root");
  });

  it("never exposes sensitive config mutation values", () => {
    const hiddenValueOne = fakeSecret("config-preview");
    const hiddenValueTwo = fakeSecret("config-argument");
    const output = preview([
      configItem({
        sensitive: true,
        value: { first: hiddenValueOne, args: ["--value", hiddenValueTwo] },
      }),
    ]);
    expectText(output, "1 item, 0 conflicts, 1 sensitive item", "codex-plugins-root [sensitive]");
    expect(output).not.toContain(hiddenValueOne);
    expect(output).not.toContain(hiddenValueTwo);
  });

  it("redacts secrets from item text and warnings", () => {
    const secret = fakeSecret("preview");
    const reason = `Provider rejected ${secret}`;
    const output = preview([item("plugin", { status: "error", reason })], {
      warnings: [`Retry with Bearer ${secret}`],
    });
    expect(output).not.toContain(secret);
    expect(output).toContain("[redacted]");
  });
});

describe("formatMigrationResult", () => {
  it("renders provider warnings absent from migration next steps", () => {
    const warning = "Some imported settings require manual review before activation.";
    const output = result([item("skill", { status: "migrated" })], {
      warnings: [warning],
      nextSteps: [nextStep],
    });
    expectText(output, "Warnings:", `⚠️  ${warning}`, `• ${nextStep}`);
  });

  it("renders warning-backed next steps with a warning glyph", () => {
    const warning =
      "Some Codex plugins could not be migrated. Run `openclaw migrate codex` after onboarding.";
    const output = result([item("plugin", { status: "warning" })], {
      warnings: [warning],
      nextSteps: [warning, nextStep],
    });
    expectText(output, `⚠️  ${warning}`, `• ${nextStep}`);
    expect(output.split(warning)).toHaveLength(2);
  });

  it("says (Skipped) for user-deselected skill/plugin items", () => {
    const output = result([
      item("skill", { status: "skipped", reason: "not selected for migration" }),
    ]);
    expect(output).toContain("(Skipped)");
  });

  it("redacts secrets from item text, provider warnings, and next steps", () => {
    const secret = fakeSecret("result");
    const message = `Provider returned Bearer ${secret}`;
    const output = result([item("plugin", { status: "warning", message })], {
      warnings: [`Retry with Bearer ${secret}`],
      nextSteps: [`Save ${secret} for retry`],
    });
    expect(output).not.toContain(secret);
    expectText(output, "Retry with [redacted]", "[redacted]");
  });
});
