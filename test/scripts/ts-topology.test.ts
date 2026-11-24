import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { analyzeTopology, filterRecordsForReport } from "../../scripts/lib/ts-topology/analyze.js";
import { renderTextReport } from "../../scripts/lib/ts-topology/reports.js";
import { createFilesystemPublicSurfaceScope } from "../../scripts/lib/ts-topology/scope.js";
import { main } from "../../scripts/ts-topology.ts";
import { createCapturedIo } from "../helpers/captured-io.js";

const repoRoot = path.join(process.cwd(), "test", "fixtures", "ts-topology", "basic");

const publicSurfaceEnvelope = analyzeTopology({
  repoRoot,
  scope: createFilesystemPublicSurfaceScope(repoRoot, {
    id: "custom",
    entrypointRoot: "src/public",
    importPrefix: "fixture-sdk",
  }),
  report: "public-surface-usage",
});

async function runCli(args: string[]) {
  const captured = createCapturedIo();
  const code = await main(args, captured.io);
  return { code, stdout: captured.readStdout(), stderr: captured.readStderr() };
}
function render(overrides: Partial<typeof publicSurfaceEnvelope> = {}, limit = 2) {
  return renderTextReport({ ...publicSurfaceEnvelope, ...overrides }, limit);
}

it("runs the CLI entrypoint when invoked from a filesystem path", () => {
  const args = ["--import", "tsx", path.resolve("scripts/ts-topology.ts"), "--help"];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  expect(result).toMatchObject({ status: 1, stdout: "" });
  expect(result.stderr).toContain("Usage: ts-topology");
});

it("renders stable text summaries for the public-surface report", () => {
  expect(render({}, 3)).toMatchInlineSnapshot(`
      "Scope: custom
      Public exports analyzed: 6
      Production-used exports: 3
      Single-owner shared exports: 2
      Unused public exports: 2
      
      Top 2 candidate-to-move exports:
      - fixture-sdk:aliasedThing -> src/lib/shared.ts:10 (prodRefs=1, owners=extension:alpha, sharedness=35, move=85)
      - fixture-sdk:singleOwnerHelper -> src/lib/shared.ts:6 (prodRefs=1, owners=extension:alpha, sharedness=35, move=85)
      
      Top 1 duplicated public exports:
      - fixture-sdk:sharedThing via fixture-sdk, fixture-sdk/extra (src/lib/shared.ts:2)"
    `);
});

it("emits stable JSON through the CLI and filtered report output", async () => {
  const result = await runCli([
    "--scope=custom",
    "--entrypoint-root=src/public",
    "--import-prefix=fixture-sdk",
    "--repo-root=test/fixtures/ts-topology/basic",
    "--report=single-owner-shared",
    "--json",
  ]);

  expect(result.code).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.report).toBe("single-owner-shared");
  expect(payload.records.map((record: { exportNames: string[] }) => record.exportNames[0])).toEqual(
    ["aliasedThing", "singleOwnerHelper"],
  );

  expect(
    render({
      report: "consumer-topology",
      records: filterRecordsForReport(publicSurfaceEnvelope.records, "consumer-topology"),
    }),
  ).toMatchInlineSnapshot(`
      "Scope: custom
      Records with consumers: 4
      
      Top 2 consumer-topology records:
      - fixture-sdk:sharedThing prod=3 test=0 internal=0
      - fixture-sdk:aliasedThing prod=1 test=0 internal=0"
    `);
});

it("rejects malformed CLI limits", async () => {
  const result = await runCli(["--limit=abc"]);
  expect(result).toMatchObject({ code: 1, stdout: "" });
  expect(result.stderr).toContain("--limit must be a positive integer");
});

it("throws a clear error for invalid text report names", () => {
  expect(() => render({ report: "missing-report" as typeof publicSurfaceEnvelope.report })).toThrow(
    "Unsupported topology report: missing-report",
  );
});
