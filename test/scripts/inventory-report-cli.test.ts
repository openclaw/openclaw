import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fileUtils from "../../scripts/check-file-utils.js";
import { main as runEnvReport } from "../../scripts/test-env-mutation-report.js";
import { main as runSkipReport } from "../../scripts/test-skip-inventory.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function makeFixture(
  relative = "src/example.test.ts",
  contents = 'process.env.HOME = "fixture"; it.skip("fixture", () => {});\n'.repeat(122),
) {
  const repoRoot = path.join(tempDirs.make("openclaw-inventory-argv-"), " literal root ");
  const file = path.join(repoRoot, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return repoRoot;
}

describe.each([
  { name: "env mutation", main: runEnvReport },
  { name: "skip inventory", main: runSkipReport },
])("$name CLI argument contract", ({ main }) => {
  it("uses cwd and the default limit, then honors the last split root and limit", () => {
    const repoRoot = makeFixture();
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(main([])).toBe(0);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("... 2 more finding(s)"));

    const roots = ["--repo-root", "unused", "--", "--repo-root", repoRoot];
    const limits = ["--limit", "1", "--", "--limit", "0002", "--"];
    expect(main([...roots, ...limits])).toBe(0);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("... 120 more finding(s)"));

    for (const limit of ["0", "000", String(Number.MAX_SAFE_INTEGER)]) {
      stdout.mockClear();
      expect(main(["--repo-root", repoRoot, "--limit", limit])).toBe(0);
      expect(stdout).toHaveBeenCalledOnce();
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("L122 "));
      expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("more finding(s)"));
    }
  });

  it("accepts repeated JSON flags and standalone separators", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(main(["--", "--json", "--", "--json", "--repo-root", makeFixture(), "--"])).toBe(0);
    expect(stdout).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"findingCount": 122'));
    expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("more finding(s)"));
  });

  it("accepts repeated help aliases without scanning", () => {
    const scan = vi.spyOn(fileUtils, "listRepoFilesSync");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(main(["--help", "-h", "--", "--help"])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    expect(scan).not.toHaveBeenCalled();
  });
});

const limitError = "--limit expects a non-negative integer";
const rootError = "--repo-root expects a path";
it.each([
  { argv: ["--limit"], error: limitError },
  ...["-1", "9007199254740992", "--"].map((value) => ({
    argv: ["--limit", value],
    error: limitError,
  })),
  { argv: ["--repo-root"], error: rootError },
  { argv: ["--repo-root", "-h"], error: rootError },
  { argv: ["--limit=1"], error: "Unknown argument: --limit=1" },
  { argv: ["--limit", "1", "--limit", "bad"], error: limitError },
  { argv: ["--limit", "bad", "--limit", "1"], error: limitError },
  { argv: ["--repo-root", "valid", "--repo-root", ""], error: rootError },
  { argv: ["--repo-root", "", "--repo-root", "valid"], error: rootError },
  { argv: ["--unknown", "--limit", "bad"], error: "Unknown argument: --unknown" },
  { argv: ["--limit", "bad", "--unknown"], error: limitError },
])("rejects argv %# before output or scanning, even with help", ({ argv, error }) => {
  const scan = vi.spyOn(fileUtils, "listRepoFilesSync");
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  for (const args of [argv, ["--help", ...argv], [...argv, "--help"]]) {
    expect(() => runEnvReport(args)).toThrow(new Error(error));
  }
  expect(stdout).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
});

it("registers the repeatable include-allowed flag only for the env report", () => {
  const repoRoot = makeFixture(
    "src/test-utils/openclaw-test-state.ts",
    'process.env.HOME = "fixture";',
  );
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  expect(runEnvReport(["--repo-root", repoRoot])).toBe(0);
  expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("Allowed harness findings:"));
  expect(runEnvReport(["--repo-root", repoRoot, "--include-allowed", "--include-allowed"])).toBe(0);
  expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("Allowed harness findings:"));
  expect(() => runSkipReport(["--help", "--include-allowed"])).toThrow(
    new Error("Unknown argument: --include-allowed"),
  );
});
