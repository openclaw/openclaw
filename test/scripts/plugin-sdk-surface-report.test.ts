// Plugin Sdk Surface Report tests cover plugin sdk surface report script behavior.
import { spawnSync } from "node:child_process";
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

function runSurfaceReport(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/plugin-sdk-surface-report.mts", "--check"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...baseSurfaceReportEnv(),
        ...env,
      },
    },
  );
}

type PublicSurfaceCounts = {
  callableExports: number;
  exports: number;
  wildcardReexports: number;
};

function readDefaultPublicSurfaceBudgets(): PublicSurfaceCounts {
  const { budgets } = readPluginSdkSurfaceBudgets({});
  return {
    exports: budgets.publicExports,
    callableExports: budgets.publicFunctionExports,
    wildcardReexports: budgets.publicWildcardReexports,
  };
}

type SurfaceReport = Awaited<ReturnType<typeof collectPluginSdkSurfaceReport>>;
let surfaceReport: SurfaceReport;

function readCurrentPublicSurfaceCounts(): PublicSurfaceCounts {
  return {
    exports: surfaceReport.publicStats.totals.exports,
    callableExports: surfaceReport.publicStats.totals.callableExports,
    wildcardReexports: surfaceReport.publicWildcards.count,
  };
}

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

  it("rejects unknown CLI options before collecting SDK stats", () => {
    for (const args of [["--chekc"], ["chekc", "--help"]]) {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/plugin-sdk-surface-report.mts", ...args],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(`Unknown plugin SDK surface report option: ${args[0]}`);
      expect(result.stderr).not.toContain("at ");
    }
  });

  it("prints help before collecting SDK stats", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/plugin-sdk-surface-report.mts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Usage: node --import tsx scripts/plugin-sdk-surface-report.mts",
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("all SDK entrypoints:");
  });

  it("rejects loose numeric budget env vars before collecting SDK stats", () => {
    const result = runSurfaceReport({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS: "1e9",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS must be a non-negative integer",
    );
    expect(result.stderr).not.toContain("at ");
  });

  it("rejects unsafe budget env vars before collecting SDK stats", () => {
    const result = runSurfaceReport({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS: "9007199254740992",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_EXPORTS must be a safe non-negative integer",
    );
    expect(result.stderr).not.toContain("at ");
  });

  it("accepts exact deprecated export budget overrides by public entrypoint", () => {
    const budgetConfig = readPluginSdkSurfaceBudgets({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT: JSON.stringify({ core: 3 }),
    });

    expect(evaluatePluginSdkSurfaceReport(surfaceReport, budgetConfig)).not.toContain(
      expect.stringContaining("public deprecated exports in core"),
    );
  });

  it("keeps default public surface budgets pinned to current source counts", () => {
    expect(readDefaultPublicSurfaceBudgets()).toEqual(readCurrentPublicSurfaceCounts());
    const inboundReplyDispatch =
      surfaceReport.publicStats.byEntrypoint.get("inbound-reply-dispatch");
    expect(inboundReplyDispatch).toBeDefined();
    expect(
      readPluginSdkSurfaceBudgets({}).publicDeprecatedExportsByEntrypointBudget[
        "inbound-reply-dispatch"
      ],
    ).toBe(inboundReplyDispatch?.deprecatedExports);
  });

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
    const budget = readDefaultPublicSurfaceBudgets().callableExports;
    const budgetConfig = readPluginSdkSurfaceBudgets({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_FUNCTION_EXPORTS: String(budget - 1),
    });

    expect(evaluatePluginSdkSurfaceReport(surfaceReport, budgetConfig)).toContain(
      `public callable exports ${budget} > ${budget - 1}`,
    );
  });

  it("rejects deprecated export growth by public entrypoint", () => {
    const budgetConfig = readPluginSdkSurfaceBudgets({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT: JSON.stringify({ core: 1 }),
    });

    expect(evaluatePluginSdkSurfaceReport(surfaceReport, budgetConfig)).toContain(
      "public deprecated exports in core 3 > 1",
    );
  });
});
