import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

function runBoundaryReport(...args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/plugin-boundary-report.ts", ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
}

describe("plugin-boundary-report", () => {
  it("emits compact CI-safe summary JSON", () => {
    const output = runBoundaryReport(
      "--summary",
      "--json",
      "--fail-on-cross-owner",
      "--fail-on-unclassified-unused-reserved",
    );
    const summary = JSON.parse(output) as {
      pluginSdk?: {
        crossOwnerReservedImportCount?: unknown;
        dormantReservedEligibleForRemovalCount?: unknown;
        unclassifiedUnusedReservedCount?: unknown;
      };
      memoryHostSdk?: {
        implementation?: unknown;
      };
    };

    expect(summary.pluginSdk?.crossOwnerReservedImportCount).toBe(0);
    expect(summary.pluginSdk?.dormantReservedEligibleForRemovalCount).toBe(0);
    expect(summary.pluginSdk?.unclassifiedUnusedReservedCount).toBe(0);
    expect(summary.memoryHostSdk?.implementation).toBe("private-core-bridge");
  });

  it("emits an owner-scoped dormant SDK retirement plan", () => {
    const output = runBoundaryReport("--retirement-plan", "--owner", "matrix");

    expect(output).toContain("# Plugin SDK Dormant Reserved Subpath Retirement Plan");
    expect(output).toContain("Owner filter: `matrix`");
    expect(output).toContain("Dormant reserved subpaths: 6");
    expect(output).toContain(
      "`openclaw/plugin-sdk/matrix-runtime-heavy` remove after `2026-07-24`",
    );
    expect(output).toContain(
      "replacement: Matrix local runtime-api plus doctor/fix migration paths",
    );
  });
});
