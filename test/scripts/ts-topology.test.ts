// Ts Topology tests cover ts topology script behavior.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeTopology, filterRecordsForReport } from "../../scripts/lib/ts-topology/analyze.js";
import { renderTextReport } from "../../scripts/lib/ts-topology/reports.js";
import { createFilesystemPublicSurfaceScope } from "../../scripts/lib/ts-topology/scope.js";
import { main } from "../../scripts/ts-topology.ts";
import { createCapturedIo } from "../helpers/captured-io.js";

const repoRoot = path.join(process.cwd(), "test", "fixtures", "ts-topology", "basic");

function buildFixtureScope() {
  return createFilesystemPublicSurfaceScope(repoRoot, {
    id: "custom",
    entrypointRoot: "src/public",
    importPrefix: "fixture-sdk",
  });
}

const fixtureScope = buildFixtureScope();
const publicSurfaceEnvelope = analyzeTopology({
  repoRoot,
  scope: fixtureScope,
  report: "public-surface-usage",
});

function deriveReportEnvelope(report: Parameters<typeof filterRecordsForReport>[1]) {
  return {
    ...publicSurfaceEnvelope,
    report,
    records: filterRecordsForReport(publicSurfaceEnvelope.records, report),
  };
}

describe("ts-topology", () => {
  it("runs the CLI entrypoint when invoked from a filesystem path", () => {
    const scriptPath = path.resolve("scripts/ts-topology.ts");
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, "--help"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: ts-topology");
  });

  it("renders stable text summaries for the public-surface report", () => {
    expect(
      renderTextReport({ ...publicSurfaceEnvelope, limit: 3 } as typeof publicSurfaceEnvelope, 3),
    ).toMatchInlineSnapshot(`
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
    const captured = createCapturedIo();
    const jsonExit = await main(
      [
        "--scope=custom",
        "--entrypoint-root=src/public",
        "--import-prefix=fixture-sdk",
        "--repo-root=test/fixtures/ts-topology/basic",
        "--report=single-owner-shared",
        "--json",
      ],
      captured.io,
    );

    expect(jsonExit).toBe(0);
    const payload = JSON.parse(captured.readStdout());
    expect(payload.report).toBe("single-owner-shared");
    expect(
      payload.records.map((record: { exportNames: string[] }) => record.exportNames[0]),
    ).toEqual(["aliasedThing", "singleOwnerHelper"]);

    expect(renderTextReport(deriveReportEnvelope("consumer-topology"), 2)).toMatchInlineSnapshot(`
      "Scope: custom
      Records with consumers: 4
      
      Top 2 consumer-topology records:
      - fixture-sdk:sharedThing prod=3 test=0 internal=0
      - fixture-sdk:aliasedThing prod=1 test=0 internal=0"
    `);
  });

  it("rejects malformed CLI limits", async () => {
    const captured = createCapturedIo();
    const exitCode = await main(["--limit=abc"], captured.io);

    expect(exitCode).toBe(1);
    expect(captured.readStderr()).toContain("--limit must be a positive integer");
    expect(captured.readStdout()).toBe("");
  });

  it("throws a clear error for invalid text report names", () => {
    expect(() =>
      renderTextReport(
        {
          ...publicSurfaceEnvelope,
          report: "missing-report" as typeof publicSurfaceEnvelope.report,
        },
        2,
      ),
    ).toThrow("Unsupported topology report: missing-report");
  });
});
