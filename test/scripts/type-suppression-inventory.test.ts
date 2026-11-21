import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectTypeSuppressionReport } from "../../scripts/type-suppression-inventory.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function reportFixture(files: Record<string, string>) {
  const f = fixtureFiles(tempDirs.make("openclaw-type-suppressions-"));
  for (const [relativePath, source] of Object.entries(files)) {
    f.write(relativePath, source);
  }
  return collectTypeSuppressionReport({ files: Object.keys(files), repoRoot: f.root });
}

it.each(["\n", "\r\n"])("reports comment markers once with %j line endings", (newline) => {
  const report = reportFixture({
    "src/comments.ts": [
      'const text = "\u{1f680} @ts-expect-error string";',
      "const template = `@ts-expect-error template`;",
      "function example() {",
      "  /* @ts-expect-error first",
      "   * @ts-expect-error second",
      "   */",
      "} // @ts-expect-error trailing",
      'consume("\u96ea"); /* @ts-expect-error left */ /* @ts-expect-error right */',
      "consume(",
      "  1",
      "  // @ts-expect-error closing token",
      ");",
      "// @ts-expect-error eof",
    ].join(newline),
  });

  const suffixes = ["first", "second", "trailing", "left */", "right */", "closing token", "eof"];
  expect(report.findings).toEqual(
    suffixes.map((suffix, index) => ({
      excerpt: `@ts-expect-error ${suffix}`,
      line: [4, 5, 7, 8, 8, 11, 13][index],
      file: "src/comments.ts",
      kind: "expect-error",
    })),
  );
});

it("detects syntax suppressions without counting prose", () => {
  const report = reportFixture({
    "src/example.ts": `
        const prose = "as any and @ts-expect-error";
        const interpolated = \`value: \${value}\`;
        const first = value as any;
        const second = <any>value;
        const third = value as /* preserved trivia */ any;
        const fourth = </* preserved trivia */ any>value;
        const fifth = value as // preserved line trivia
          any;
        const typeOnly: any = value;
        // @ts-expect-error invalid contract fixture
        consume({ invalid: true });
      `,
    "src/plain.ts": "export const value = 1;",
  });

  expect(report.summary).toMatchObject({
    findingCount: 6,
    kindCounts: { "as-any": 3, "expect-error": 1, "type-assertion-any": 2 },
    scannedFileCount: 2,
    touchedFileCount: 1,
  });
  expect(report.findings.map(({ kind, line }) => [kind, line])).toEqual([
    ["as-any", 4],
    ["type-assertion-any", 5],
    ["as-any", 6],
    ["type-assertion-any", 7],
    ["as-any", 8],
    ["expect-error", 11],
  ]);
});

it("keeps unchecked any casts at zero", () => {
  const report = collectTypeSuppressionReport({ repoRoot });
  expect(report.summary.kindCounts).toMatchObject({ "as-any": 0, "type-assertion-any": 0 });
});
