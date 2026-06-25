// Plugin Sdk Surface Report tests cover plugin sdk surface report script behavior.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function runSurfaceReport(env: Record<string, string>) {
  return spawnSync(process.execPath, ["scripts/plugin-sdk-surface-report.mjs", "--check"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

type PublicSurfaceCounts = {
  callableExports: number;
  exports: number;
  wildcardReexports: number;
};

function readDefaultPublicSurfaceBudgets(): PublicSurfaceCounts {
  const source = readFileSync("scripts/plugin-sdk-surface-report.mjs", "utf8");
  const readFallback = (budgetKey: string) => {
    const match = new RegExp(
      `${budgetKey}:\\s*readBudgetEnv\\(\\s*"[^"]+",\\s*(\\d+)`,
      "u",
    ).exec(source);
    if (match === null || match[1] === undefined) {
      throw new Error(`failed to read default ${budgetKey} budget`);
    }
    return Number(match[1]);
  };
  return {
    exports: readFallback("publicExports"),
    callableExports: readFallback("publicFunctionExports"),
    wildcardReexports: readFallback("publicWildcardReexports"),
  };
}

function readCurrentPublicSurfaceCounts(): PublicSurfaceCounts {
  const result = runSurfaceReport({});
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");

  const totalsMatch =
    /public package SDK entrypoints:[\s\S]*?\n {2}exports: (\d+)\n {2}callable exports: (\d+)/u.exec(
      result.stdout,
    );
  const wildcardsMatch = /public wildcard reexports: (\d+)/u.exec(result.stdout);
  if (
    totalsMatch === null ||
    totalsMatch[1] === undefined ||
    totalsMatch[2] === undefined ||
    wildcardsMatch === null ||
    wildcardsMatch[1] === undefined
  ) {
    throw new Error("failed to read current public surface counts");
  }
  return {
    exports: Number(totalsMatch[1]),
    callableExports: Number(totalsMatch[2]),
    wildcardReexports: Number(wildcardsMatch[1]),
  };
}

describe("plugin SDK surface report", () => {
  it("rejects unknown CLI options before collecting SDK stats", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/plugin-sdk-surface-report.mjs", "--chekc"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown plugin SDK surface report option: --chekc");
    expect(result.stderr).not.toContain("at ");
  });

  it("prints help before collecting SDK stats", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/plugin-sdk-surface-report.mjs", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node scripts/plugin-sdk-surface-report.mjs");
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
    const result = runSurfaceReport({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT: JSON.stringify({ core: 2 }),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("keeps default public surface budgets pinned to current source counts", () => {
    expect(readDefaultPublicSurfaceBudgets()).toEqual(readCurrentPublicSurfaceCounts());
  });

  it("keeps generated package declarations out of source surface counts", () => {
    const budget = readCurrentPublicSurfaceCounts().callableExports;
    const result = runSurfaceReport({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_FUNCTION_EXPORTS: String(budget - 1),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`public callable exports ${budget} > ${budget - 1}`);
  });

  it("rejects deprecated export growth by public entrypoint", () => {
    const result = runSurfaceReport({
      OPENCLAW_PLUGIN_SDK_MAX_PUBLIC_DEPRECATED_EXPORTS_BY_ENTRYPOINT: JSON.stringify({ core: 1 }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public deprecated exports in core 2 > 1");
  });
});
