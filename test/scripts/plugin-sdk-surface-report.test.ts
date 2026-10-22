import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import {
  evaluatePluginSdkShippedSurface,
  type PluginSdkShippedSurface,
} from "../../scripts/lib/plugin-sdk-shipped-surface.mts";
import {
  collectPluginSdkSurfaceReport,
  evaluatePluginSdkSurfaceReport,
  readPluginSdkSurfaceBudgets,
} from "../../scripts/plugin-sdk-surface-report.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";

const fixtures = createFixtureLifetime();
afterEach(() => fixtures.cleanup());

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

// Linux's strict owner distinguishes a zombie compiler leader from its still-live threads.
it.runIf(process.platform === "linux")(
  "joins the registered SDK command's compiler before reporting success",
  async ({ signal }) => {
    await fixtures.run(async () => {
      const directory = fixtures.createTempDir("plugin-sdk-surface-lifetime-");
      const stdout = path.join(directory, "stdout.log");
      const stderr = path.join(directory, "stderr.log");
      await using out = await fs.promises.open(stdout, "wx", 0o600);
      await using err = await fs.promises.open(stderr, "wx", 0o600);
      const code = await runManagedCommand({
        bin: "pnpm",
        args: ["plugin-sdk:surface:check"],
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("OPENCLAW_PLUGIN_SDK_MAX_"),
          ),
        ),
        signal,
        requireProcessTreeExit: true,
        stdio: ["ignore", out.fd, err.fd],
      });
      expect(code, fs.readFileSync(stderr, "utf8")).toBe(0);
      expect(fs.readFileSync(stdout, "utf8")).toContain("all SDK entrypoints:");
    });
  },
);

it("accepts frozen named facades while rejecting missing deprecated reexports", () => {
  expect(surfaceReport.deprecatedBarrelWithoutReexports).toEqual([]);
  surfaceReport.deprecatedBarrelWithoutReexports = ["fixture-facade"];
  expect(failures()).toContain("deprecated barrel entrypoints without reexports: fixture-facade");
});

it("keeps approval store internals out of public approval helpers", () => {
  const source = fs.readFileSync("src/plugin-sdk/exec-approvals-runtime.ts", "utf8");
  expect(source).not.toMatch(/export\s+(?:type\s+)?\*\s+from\s+["'][^"']*exec-approvals/u);

  for (const internalName of [
    "ensureExecApprovalsSnapshot",
    "persistAllowAlwaysDecisionLocked",
    "recordAllowlistMatchesUseLocked",
    "resolveExecApprovalsLocked",
    "restoreExecApprovalsSnapshotLocked",
    "updateExecApprovals",
  ]) {
    expect(source).not.toContain(internalName);
  }
});

it("does not let a lowered export budget authorize a shipped name removal", () => {
  surfaceReport.publicStats.totals.exports--;
  const inventory: PluginSdkShippedSurface = {
    schema: "openclaw.plugin-sdk-shipped-surface/v1",
    release: "v2026.9.8",
    commit: "f".repeat(40),
    entrypoints: { core: ["RemovedPublicType"] },
  };
  expect(failures("PUBLIC_EXPORTS", surfaceReport.publicStats.totals.exports)).toEqual([]);
  expect(
    evaluatePluginSdkShippedSurface(inventory, new Map([["core", []]]), [], "2026-10-02"),
  ).toEqual([{ subpath: "core", missingSubpath: false, names: ["RemovedPublicType"] }]);
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
