import { describe, expect, it } from "vitest";
import { recognizeDictatedFileReferences as recognize } from "./dictation-file-references.ts";

const english = { locale: "en-US" };

describe("explicit dictated file references", () => {
  it.each([
    "The phrase reference file appears in the documentation.",
    'Say "reference file auth.ts end reference" to illustrate the syntax.',
    "Say 'let's use reference file auth.ts end reference' as an example.",
    "Say “reference file auth.ts end reference” as quoted instructions.",
    "Say ‘let’s use reference file auth.ts end reference’ as an example.",
    "`reference file auth.ts end reference` is code",
    "literal reference file auth.ts end reference end literal",
    "literal reference file auth.ts end reference",
  ])("preserves prose or literal data: %s", (text) => {
    expect(recognize(text, english)).toMatchObject({ text, commands: [] });
  });

  it("retains surrounding contractions and distinct command ranges", () => {
    const text =
      "👋 Let's inspect reference file Src slash Auth dot TS end reference because it's failing; also reference file résumé dot md end reference, please";
    const plan = recognize(text, english);
    expect(plan.text).toBe(text);
    expect(plan.commands.map(({ query }) => query)).toEqual(["Src/Auth.TS", "résumé.md"]);
    expect(plan.commands.map(({ start, end }) => text.slice(start, end))).toEqual([
      "reference file Src slash Auth dot TS end reference",
      "reference file résumé dot md end reference",
    ]);
  });

  it.each([undefined, "de-DE", "en-GB", "fr"])(
    "does not interpret unsupported locale %s",
    (locale) => {
      expect(recognize("reference file a.ts end reference", { locale }).status).toBe(
        "unsupported-locale",
      );
    },
  );

  it("requires a separate opt-in for whole-utterance shorthand", () => {
    const text = "reference file src slash auth dot ts";
    expect(recognize(text, english).commands).toEqual([]);
    expect(recognize(text, { ...english, commandMode: true }).commands[0]?.query).toBe(
      "src/auth.ts",
    );
    expect(recognize(`Please ${text}`, { ...english, commandMode: true }).commands).toEqual([]);
  });

  it("keeps current-file intent separate from a guessed path", () => {
    expect(recognize("reference current file end reference", english).commands).toEqual([
      { start: 0, end: 36, query: "", kind: "current" },
    ]);
  });

  it("protects exact supplied spans and literal mode", () => {
    const text = "reference file a.ts end reference";
    expect(
      recognize(text, { ...english, protectedRanges: [{ start: 0, end: text.length }] }).commands,
    ).toEqual([]);
    expect(recognize(text, { ...english, literal: true }).status).toBe("literal");
  });

  it.each([" ", "x".repeat(2049), "🦊".repeat(513)])(
    "rejects empty or oversized queries",
    (query) => {
      expect(recognize(`reference file ${query} end reference`, english).commands).toEqual([]);
    },
  );

  it("enforces command count and UTF-8 transcript bounds without truncation", () => {
    const text = Array.from({ length: 17 }, () => "reference file a.ts end reference").join(" ");
    expect(recognize(text, english)).toEqual({ text, status: "too-large", commands: [] });
    expect(recognize("🦊".repeat(8193), english).status).toBe("too-large");
  });
});
