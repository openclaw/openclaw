import fs from "node:fs";
import { beforeAll, beforeEach, expect, it } from "vitest";
import {
  collectPluginSdkSurfaceReport,
  evaluatePluginSdkSurfaceReport,
  readPluginSdkSurfaceBudgets,
} from "../../scripts/plugin-sdk-surface-report.mts";

type SurfaceReport = Awaited<ReturnType<typeof collectPluginSdkSurfaceReport>>;
let baseReport: SurfaceReport;
let surfaceReport: SurfaceReport;
function failures(budget?: string, value: number | Record<string, number> = 0) {
  const env = budget ? { [`OPENCLAW_PLUGIN_SDK_MAX_${budget}`]: JSON.stringify(value) } : {};
  return evaluatePluginSdkSurfaceReport(surfaceReport, readPluginSdkSurfaceBudgets(env));
}

beforeAll(async () => {
  baseReport = await collectPluginSdkSurfaceReport();
});
beforeEach(() => {
  surfaceReport = structuredClone(baseReport);
});

it("accepts frozen named facades while rejecting missing deprecated reexports", () => {
  expect(surfaceReport.deprecatedBarrelWithoutReexports).toEqual([]);
  surfaceReport.deprecatedBarrelWithoutReexports = ["fixture-facade"];
  expect(failures()).toContain("deprecated barrel entrypoints without reexports: fixture-facade");
});

it("keeps approval store internals out of public approval helpers", () => {
  const source = fs.readFileSync("src/plugin-sdk/exec-approvals-runtime.ts", "utf8");
  expect(source).not.toMatch(/export\s+(?:type\s+)?\*\s+from\s+["'][^"']*exec-approvals/u);

  expect(source).not.toMatch(
    /ensureExecApprovalsSnapshot|persistAllowAlwaysDecisionLocked|recordAllowlistMatchesUseLocked|resolveExecApprovalsLocked|restoreExecApprovalsSnapshotLocked|updateExecApprovals/u,
  );
});

it("rejects callable surface growth from the canonical source graph", () => {
  const callableExports = surfaceReport.publicStats.totals.callableExports;
  expect(failures("PUBLIC_FUNCTION_EXPORTS", callableExports - 1)).toContain(
    `public callable exports ${callableExports} > ${callableExports - 1}`,
  );
});

it("rejects deprecated export growth by public entrypoint", () => {
  const core = surfaceReport.publicStats.byEntrypoint.get("core")!;
  surfaceReport.publicStats.byEntrypoint = new Map([["core", { ...core, deprecatedExports: 3 }]]);
  expect(failures("PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT", { core: 1 })).toContain(
    "public deprecated exports in core 3 > 1",
  );
});
