import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseInventoryReportCliArgs } from "../../scripts/lib/report-cli-helpers.mts";
import { main as runEnvReport } from "../../scripts/test-env-mutation-report.js";
import { main as runSkipReport } from "../../scripts/test-skip-inventory.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
function fixture(relative = "src/example.test.ts") {
  const root = path.join(tempDirs.make("inventory-cli-"), " literal root ");
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'process.env.HOME = "fixture"; it.skip("fixture", () => {});');
  return root;
}

it("parses defaults and repeated split flags once for both report callers", () => {
  expect(parseInventoryReportCliArgs([]).limit).toBe(120);
  const roots = ["--repo-root", "unused", "--", "--repo-root", " literal root "];
  const flags = ["--limit", "1", "--limit", "0002", "--json", "--json", "-h", "--help"];
  expect(parseInventoryReportCliArgs([...roots, ...flags])).toMatchObject({
    help: true,
    json: true,
    limit: 2,
    repoRoot: " literal root ",
  });
});

it.each([runEnvReport, runSkipReport])("wires the report CLI to JSON output and help", (main) => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  expect(main(["--json", "--repo-root", fixture()])).toBe(0);
  expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('"findingCount": 1'));
  expect(main(["--help", "--repo-root", "/missing-report-root"])).toBe(0);
  expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("Usage:"));
});

it.each([
  [["--limit"], "--limit expects a non-negative integer"],
  [["--limit", "9007199254740992"], "--limit expects a non-negative integer"],
  [["--limit", "bad"], "--limit expects a non-negative integer"],
  [["--repo-root"], "--repo-root expects a path"],
  [["--unknown"], "Unknown argument: --unknown"],
] as const)("validates %j even with help", (args, error) => {
  expect(() => parseInventoryReportCliArgs(["--help", ...args])).toThrow(error);
});

it("registers include-allowed only for the env report", () => {
  const root = fixture("src/test-utils/openclaw-test-state.ts");
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  expect(runEnvReport(["--repo-root", root])).toBe(0);
  expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("Allowed harness findings:"));
  expect(runEnvReport(["--repo-root", root, "--include-allowed", "--include-allowed"])).toBe(0);
  expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("Allowed harness findings:"));
  expect(() => runSkipReport(["--help", "--include-allowed"])).toThrow(
    "Unknown argument: --include-allowed",
  );
});
