import { describe, expect, it } from "vitest";
import {
  filterRawCopyEntries,
  filterTranslationKeysBySurface,
  formatReport,
  parseArgs,
  summarizeRawCopy,
} from "../../scripts/control-ui-i18n-report.ts";
import type { RawCopyBaselineEntry } from "../../scripts/lib/control-ui-i18n-raw-copy.ts";

const rawCopyEntry = (path: string, count: number): RawCopyBaselineEntry => ({
  count,
  path,
  kind: "html-text",
  name: "text",
  text: "Send",
});
const entries = [
  rawCopyEntry("ui/src/ui/chat/render.ts", 2),
  rawCopyEntry("ui/src/ui/views/agents-panels-tools.ts", 1),
  rawCopyEntry("ui/src/ui/views/config-form.render.ts", 4),
];

const localeMeta = {
  generatedAt: "2026-05-13T00:00:00.000Z",
  locale: "zh-CN",
  model: "gpt-5.5",
  provider: "openai",
  sourceHash: "hash",
  totalKeys: 3,
  translatedKeys: 2,
  workflow: 1,
};
const translationSummary =
  "Existing zh-CN translation keys (all Control UI): 2/3 filled, 1 fallback.";

function reportFor(fallbackKeysInScope: string[], fallbackKeys = fallbackKeysInScope) {
  return formatReport({
    locale: { fallbackKeysInScope, meta: { ...localeMeta, fallbackKeys } },
    rawCopy: summarizeRawCopy(entries, 1),
    surface: "chat",
  });
}

describe("control-ui-i18n report helpers", () => {
  it.each(["--surface", "--locale", "--top"])("rejects option-shaped values for %s", (flag) => {
    expect(() => parseArgs([flag, "-h"])).toThrow(`${flag} requires a value`);
  });

  it("rejects invalid numeric limits", () => {
    for (const value of ["3abc", "1.5", "0", "999999999999999999999999999"]) {
      expect(() => parseArgs(["--top", value])).toThrow("--top must be a positive integer");
    }
  });

  it("rejects locale path traversal before filesystem access", () => {
    expect(parseArgs(["--locale", "zh-CN"])).toMatchObject({ locale: "zh-CN" });
    expect(() => parseArgs(["--locale", "../zh-CN"])).toThrow("unknown locale");
    expect(() => parseArgs(["--locale", "../../../../scripts/control-ui-i18n-report"])).toThrow(
      "unknown locale",
    );
  });

  it("filters raw-copy entries by path surface token", () => {
    expect(filterRawCopyEntries(entries, "agents")).toEqual([entries[1]]);
    expect(filterRawCopyEntries(entries, "config")).toEqual([entries[2]]);
    expect(filterRawCopyEntries(entries, "missing")).toEqual([]);
  });

  it("filters translation keys by surface token", () => {
    const keys = ["chat.composer.send", "sessionsView.thinking"];
    expect(filterTranslationKeysBySurface(keys, "chat")).toEqual(["chat.composer.send"]);
    expect(filterTranslationKeysBySurface(keys, "sessions")).toEqual(["sessionsView.thinking"]);
  });

  it("formats pasteable report text", () => {
    const report = reportFor(["actions.cancel"]);
    for (const line of [
      "Control UI i18n baseline report",
      "Scope: Chat, Simplified Chinese (zh-CN)",
      "Based on: current raw-copy baseline and locale metadata. Not a drift check.",
      "Hardcoded UI text outside i18n: 3 pieces in code, 7 total occurrences.",
      translationSummary,
      "Chat still has UI text written directly in code.",
      "zh-CN has 1 missing key.",
      "4 Config form: ui/src/ui/views/config-form.render.ts",
      "Move text from the focus modules into translation keys.",
      "Do not hand-edit generated locale, translation memory, or i18n metadata files.",
      "Run pnpm ui:i18n:sync after adding translation keys.",
    ]) {
      expect(report).toContain(`${line}\n`);
    }
    expect(report).not.toContain("matches English");
    expect(report).not.toContain("raw-copy entries");
  });

  it("keeps fallback-key issues scoped to the selected surface", () => {
    const report = reportFor([], ["usage.common.emptyValue"]);

    expect(report).toContain(`${translationSummary}\n`);
    expect(report).toContain("No zh-CN locale problems found in this scope.\n");
    expect(report).not.toContain("zh-CN has 1 missing key.\n");
  });
});
