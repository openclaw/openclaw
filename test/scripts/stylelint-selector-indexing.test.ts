import { createHash } from "node:crypto";
import path from "node:path";
import stylelint from "stylelint";
import { describe, expect, it } from "vitest";
import plugin from "../../config/stylelint-selector-indexing.mjs";

const ruleName = "openclaw/no-unindexed-selector-list";
const file = "ui/src/styles/selector-indexing-test.css";
// The allowance identity is a documented exact normalized selector-context hash.
const legacyId = createHash("sha256").update('[":is(.old-a,.old-b)"]').digest("hex");

async function lint(
  code: string,
  allowances: Record<string, Record<string, number>> = {},
  filename = file,
) {
  const result = await stylelint.lint({
    code,
    codeFilename: path.resolve(filename),
    config: { plugins: [plugin], rules: { [ruleName]: [true, { allowances }] } },
  });
  return result.results[0]!.warnings.map((warning) => ({ line: warning.line, text: warning.text }));
}

describe(ruleName, () => {
  it("rejects unkeyed subject class unions while retaining separately keyed and ancestor selectors", async () => {
    const warnings = await lint(
      [
        ":is(.a,.b) { color: red; }",
        ".ancestor > :where(.a,.b):hover { color: red; }",
        "* + :is(.a,.b) { color: red; }",
        ".parent { > :is(.a,.b) { color: red; } }",
        ":is(.ancestor-a,.ancestor-b) .subject { color: red; }",
        ".subject:is(.a,.b) { color: red; }",
        "#subject:where(.a,.b) { color: red; }",
        "button:is(.a,.b) { color: red; }",
        "[data-role]:is(.a,.b) { color: red; }",
        ".parent { &:is(.a,.b) { color: red; } }",
        ":where(.a) { color: red; }",
        ":is(.a.active,.b) { color: red; }",
        ":not(.a,.b) { color: red; }",
        ":is(.a > .b,.c) { color: red; }",
        ":where(.key):is(.a,.b) { color: red; }",
        ":is(.ancestor .key):is(.a,.b) { color: red; }",
      ].join("\n"),
    );
    expect(warnings.map((warning) => warning.line)).toEqual([1, 2, 3, 4]);
    expect(
      warnings.every((warning) =>
        warning.text.includes("Split the unkeyed rightmost selector list"),
      ),
    ).toBe(true);
  });

  it("allows the exact recorded selector across formatting changes", async () => {
    expect(
      await lint(":is( .old-a , .old-b ) { color: red; }", { [file]: { [legacyId]: 1 } }),
    ).toEqual([]);
  });

  it("rejects additional occurrences without borrowing another selector's allowance", async () => {
    const warnings = await lint(
      [
        ":is(.old-a,.old-b) { color: red; }",
        ":is(.old-a,.old-b) { color: blue; }",
        ":is(.new-a,.new-b) { color: red; }",
      ].join("\n"),
      { [file]: { [legacyId]: 1 } },
    );
    expect(warnings.map((warning) => warning.line)).toEqual([2, 3]);
  });

  it("does not transfer allowances between files or nested selector contexts", async () => {
    const allowances = { [file]: { [legacyId]: 1 } };
    expect(
      await lint(":is(.old-a,.old-b) { color: red; }", allowances, "ui/src/styles/other.css"),
    ).toHaveLength(1);
    const warnings = await lint(".new-parent { :is(.old-a,.old-b) { color: red; } }", allowances);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((warning) => warning.text.includes("Prune selector allowance"))).toBe(
      true,
    );
  });

  it("requires deletion of a stale allowance when the last instance is fixed", async () => {
    const warnings = await lint(".old-a,.old-b { color: red; }", { [file]: { [legacyId]: 1 } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.text).toContain(
      `Prune selector allowance ${legacyId}: found 0, recorded 1`,
    );
  });
});
