// Control UI tests cover Skill Workshop modeSwitcher i18n wiring.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../locales/en.ts";

const expectedEnglish: Record<string, string> = {
  "skillWorkshop.modeSwitcher.label": "Workshop view",
  "skillWorkshop.modeSwitcher.board": "Board",
  "skillWorkshop.modeSwitcher.boardTitle": "Board view",
  "skillWorkshop.modeSwitcher.today": "Today",
  "skillWorkshop.modeSwitcher.todayTitle": "Today view",
};

function readDotted(map: Record<string, unknown>, key: string): string {
  let cursor: unknown = map;
  for (const part of key.split(".")) {
    cursor =
      cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>)[part] : undefined;
  }
  return typeof cursor === "string" ? cursor : "";
}

describe("Skill Workshop mode switcher i18n", () => {
  it("resolves the five modeSwitcher keys in English to the expected values", () => {
    const map = en as unknown as Record<string, unknown>;
    for (const [key, expected] of Object.entries(expectedEnglish)) {
      expect(readDotted(map, key), key).toBe(expected);
    }
  });

  it("exposes the five keys under skillWorkshop.modeSwitcher in en.ts", () => {
    const modeSwitcher = (en.skillWorkshop as { modeSwitcher?: unknown }).modeSwitcher;
    expect(modeSwitcher).toBeTypeOf("object");
    const map = modeSwitcher as Record<string, unknown>;
    expect(Object.keys(map).toSorted()).toEqual(
      ["board", "boardTitle", "label", "today", "todayTitle"].toSorted(),
    );
  });

  it("does not leave the legacy hard-coded literals in app-render.ts", () => {
    // The PR moves five literals into t("skillWorkshop.modeSwitcher.*").
    // Catch a regression where someone re-introduces a hard-coded label
    // or misses a call site when wiring the new keys.
    const appRenderPath = resolve(import.meta.dirname, "..", "..", "ui", "app-render.ts");
    const source = readFileSync(appRenderPath, "utf8");
    expect(source).not.toMatch(/aria-label="Workshop view"/);
    expect(source).not.toMatch(/title="Board view"/);
    expect(source).not.toMatch(/title="Today view"/);
    // The Board/Today <span> literals were the trigger for the raw-copy
    // baseline; keep this regression visible if they sneak back.
    expect(source).not.toMatch(/<span>Board<\/span>/);
    expect(source).not.toMatch(/<span>Today<\/span>/);
  });

  it("drops the legacy Workshop/Board/Today strings from the raw-copy baseline", () => {
    // ui/src/i18n/.i18n/raw-copy-baseline.json lists the remaining
    // hard-coded English copy. The five new keys must not be re-added
    // there; the i18n pipeline relies on that to know what to translate.
    const baselinePath = resolve(import.meta.dirname, "..", ".i18n", "raw-copy-baseline.json");
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
      entries?: Array<{ text?: string }>;
    };
    const texts = (baseline.entries ?? []).map((entry) => entry.text ?? "");
    expect(texts).not.toContain("Workshop view");
    expect(texts).not.toContain("Board view");
    expect(texts).not.toContain("Today view");
    expect(texts).not.toContain("Board");
    expect(texts).not.toContain("Today");
  });

  it("keeps untranslated modeSwitcher strings visible in locale fallback metadata", () => {
    const metaPath = resolve(import.meta.dirname, "..", ".i18n", "de.meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { fallbackKeys?: string[] };

    expect(meta.fallbackKeys ?? []).toEqual(expect.arrayContaining(Object.keys(expectedEnglish)));
  });
});
