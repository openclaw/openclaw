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

it("keeps unchecked any casts at zero and negative type assertions explicit", () => {
  const report = collectTypeSuppressionReport({ repoRoot });

  expect(report.summary.kindCounts).toMatchObject({ "as-any": 0, "type-assertion-any": 0 });
  expect(
    report.findings
      .filter((finding) => finding.kind === "expect-error")
      .map((finding) => `${finding.file}:${finding.excerpt}`)
      .toSorted(),
  ).toEqual(
    [
      "extensions/openai/realtime-quicksilver-session-lifecycle.test.ts:@ts-expect-error JavaScript callers must still fail before reserving a native session.",
      "scripts/lib/managed-cleanup-handoff.mts:@ts-expect-error Bun supports connect({ fd }); Node types only describe path/port connects.",
      "test/type-contracts/kysely-sync.ts:@ts-expect-error Kysely checks selected column string literals.",
      "test/type-contracts/kysely-sync.ts:@ts-expect-error Kysely checks table string literals.",
      "test/type-contracts/kysely-sync.ts:@ts-expect-error Kysely checks where-reference string literals.",
      "test/type-contracts/kysely-sync.ts:@ts-expect-error Kysely checks grouped column string literals.",
      "test/type-contracts/kysely-sync.ts:@ts-expect-error Kysely checks order references and selected aliases.",
      "src/infra/database-engine/shared-feature.conformance.test.ts:@ts-expect-error -- The bridge intentionally omits SQLite-only methods.",
      "src/infra/database-engine/transcript-reader.conformance.test.ts:@ts-expect-error -- The PostgreSQL bridge deliberately lacks unused SQLite-only methods.",
      "src/infra/net/fetch-guard.configured-origin-linklocal.test.ts:@ts-expect-error - managedProxyBypass is intentionally not public",
      "src/infra/net/fetch-guard.socks.test.ts:@ts-expect-error Undici's Node TLS intersection rejects its runtime-valid null timeout.",
      "src/infra/net/fetch-guard.socks.test.ts:@ts-expect-error Undici's Node TLS intersection rejects its runtime-valid null timeout.",
      "src/auto-reply/inbound-debounce.test.ts:@ts-expect-error Released plugins return promises instead of the current lifecycle shape.",
      "src/auto-reply/inbound-debounce.test.ts:@ts-expect-error Released plugins return promises instead of the current lifecycle shape.",
      "src/plugin-sdk/plugin-config-runtime.test.ts:@ts-expect-error Arrays are also invalid persisted plugin config objects.",
      "src/plugin-sdk/plugin-config-runtime.test.ts:@ts-expect-error Exercise malformed persisted config at the runtime boundary.",
      "test/type-contracts/plugin-entry-hook-options.ts:@ts-expect-error Trigger eligibility is only supported for before_agent_reply.",
      "test/type-contracts/plugin-entry-hook-options.ts:@ts-expect-error An empty trigger list cannot prove that a hook is inactive.",
      "test/type-contracts/plugin-entry-hook-options.ts:@ts-expect-error Tool authority is only supported for before_prompt_build.",
      "src/plugins/registry.diagnostics.test.ts:@ts-expect-error JavaScript plugins may omit the required supplement builder.",
      "src/plugins/registry.diagnostics.test.ts:@ts-expect-error Unknown JavaScript hook names must produce a diagnostic.",
      "src/plugins/registry.diagnostics.test.ts:@ts-expect-error Untyped hook input reaches the existing rejection/coercion path.",
      "src/plugins/registry.diagnostics.test.ts:@ts-expect-error Closed registration must stop before coercing untyped hook input.",
    ].toSorted(),
  );
});
