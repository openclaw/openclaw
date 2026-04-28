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
});
