import { describe, expect, it } from "vitest";
import {
  filterRawCopyEntries,
  filterTranslationKeysBySurface,
  formatReport,
  parseArgs,
  summarizeRawCopy,
} from "../../scripts/control-ui-i18n-report.ts";
import type { RawCopyBaselineEntry } from "../../scripts/lib/control-ui-i18n-raw-copy.ts";

const copy = { kind: "html-text", name: "text", text: "Send" } as const;
const entries: RawCopyBaselineEntry[] = [
  { ...copy, path: "ui/src/ui/chat/render.ts", count: 2 },
  { ...copy, path: "ui/src/ui/views/agents-panels-tools.ts", count: 1 },
  { ...copy, path: "ui/src/ui/views/config-form.render.ts", count: 4 },
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
    for (const locale of ["../zh-CN", "../../../../scripts/control-ui-i18n-report"]) {
      expect(() => parseArgs(["--locale", locale])).toThrow("unknown locale");
    }
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

  it.each<[string[], string]>([
    [["actions.cancel"], "zh-CN has 1 missing key."],
    [[], "No zh-CN locale problems found in this scope."],
  ])("formats scoped fallback keys %j", (fallbackKeysInScope, issue) => {
    const report = formatReport({
      locale: { fallbackKeysInScope, meta: { ...localeMeta, fallbackKeys: ["actions.cancel"] } },
      rawCopy: summarizeRawCopy(entries, 1),
      surface: "chat",
    });
    for (const line of [
      "Scope: Chat, Simplified Chinese (zh-CN)",
      "Hardcoded UI text outside i18n: 3 pieces in code, 7 total occurrences.",
      "Existing zh-CN translation keys (all Control UI): 2/3 filled, 1 fallback.",
      "Chat still has UI text written directly in code.",
      issue,
      "4 Config form: ui/src/ui/views/config-form.render.ts",
    ]) {
      expect(report).toContain(`${line}\n`);
    }
    expect(report.includes("zh-CN has 1 missing key.\n")).toBe(fallbackKeysInScope.length > 0);
  });
});
