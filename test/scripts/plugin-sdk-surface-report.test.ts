// Plugin Sdk Surface Report tests cover plugin sdk surface report script behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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

const pluginSdkSurfaceBudgetEnvPattern = /^OPENCLAW_PLUGIN_SDK_MAX_/u;

function baseSurfaceReportEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !pluginSdkSurfaceBudgetEnvPattern.test(key)),
  );
}

type SurfaceReport = Awaited<ReturnType<typeof collectPluginSdkSurfaceReport>>;
let surfaceReport: SurfaceReport;

describe("plugin SDK surface report", () => {
  beforeAll(async () => {
    surfaceReport = await collectPluginSdkSurfaceReport();
  });

  // Linux's strict owner distinguishes a zombie compiler leader from its still-live threads.
  it.runIf(process.platform === "linux")(
    "joins the registered SDK command's compiler before reporting success",
    async ({ signal }) => {
      await fixtures.run(async () => {
        const directory = fixtures.createTempDir("plugin-sdk-surface-lifetime-");
        const stdout = path.join(directory, "stdout.log");
        const stderr = path.join(directory, "stderr.log");
        const out = fs.openSync(stdout, "wx", 0o600);
        try {
          const err = fs.openSync(stderr, "wx", 0o600);
          try {
            const code = await runManagedCommand({
              bin: "pnpm",
              args: ["plugin-sdk:surface:check"],
              cwd: process.cwd(),
              env: baseSurfaceReportEnv(),
              signal,
              requireProcessTreeExit: true,
              stdio: ["ignore", out, err],
            });
            expect(code, fs.readFileSync(stderr, "utf8")).toBe(0);
            expect(fs.readFileSync(stdout, "utf8")).toContain("all SDK entrypoints:");
          } finally {
            fs.closeSync(err);
          }
        } finally {
          fs.closeSync(out);
        }
      });
    },
  );

  it("accepts frozen named facades while rejecting missing deprecated reexports", () => {
    expect(surfaceReport.deprecatedBarrelWithoutReexports).toEqual([]);
    const report = {
      ...surfaceReport,
      deprecatedBarrelWithoutReexports: ["fixture-facade"],
    };

    expect(evaluatePluginSdkSurfaceReport(report, readPluginSdkSurfaceBudgets({}))).toContain(
      "deprecated barrel entrypoints without reexports: fixture-facade",
    );
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
    const report = {
      ...surfaceReport,
      publicStats: {
        ...surfaceReport.publicStats,
        totals: {
          ...surfaceReport.publicStats.totals,
          exports: surfaceReport.publicStats.totals.exports - 1,
        },
      },
    };
    const budgetConfig = readPluginSdkSurfaceBudgets({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS: String(report.publicStats.totals.exports),
    });
    const inventory: PluginSdkShippedSurface = {
      schema: "openclaw.plugin-sdk-shipped-surface/v1",
      release: "v2026.9.8",
      commit: "f".repeat(40),
      entrypoints: { core: ["RemovedPublicType"] },
    };
    expect(evaluatePluginSdkSurfaceReport(report, budgetConfig)).toEqual([]);
    expect(
      evaluatePluginSdkShippedSurface(inventory, new Map([["core", []]]), [], "2026-10-02"),
    ).toEqual([{ subpath: "core", missingSubpath: false, names: ["RemovedPublicType"] }]);
  });

  it("rejects callable surface growth from the canonical source graph", () => {
    const callableExports = surfaceReport.publicStats.totals.callableExports;
    const budgetConfig = readPluginSdkSurfaceBudgets({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_FUNCTION_EXPORTS: String(callableExports - 1),
    });

    expect(evaluatePluginSdkSurfaceReport(surfaceReport, budgetConfig)).toContain(
      `public callable exports ${callableExports} > ${callableExports - 1}`,
    );
  });

  it("rejects deprecated export growth by public entrypoint", () => {
    const core = surfaceReport.publicStats.byEntrypoint.get("core")!;
    const report = {
      ...surfaceReport,
      publicStats: {
        ...surfaceReport.publicStats,
        byEntrypoint: new Map([["core", { ...core, deprecatedExports: 3 }]]),
      },
    };
    const budgetConfig = readPluginSdkSurfaceBudgets({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT: JSON.stringify({ core: 1 }),
    });

    expect(evaluatePluginSdkSurfaceReport(report, budgetConfig)).toContain(
      "public deprecated exports in core 3 > 1",
    );
  });
});
