import { describe, expect, it } from "vitest";
import {
  createDependencyChangesReport,
  dependencyDiffPathspecs,
  isDependencyFile,
  parseArgs,
} from "../../scripts/dependency-changes-report.mts";

const flags = [
  "--root",
  "--base-ref",
  "--base-lockfile",
  "--head-lockfile",
  "--json",
  "--markdown",
];

describe("dependency-changes-report", () => {
  it("reports added, removed, and changed packages", () => {
    const dependencyFileChanges = ["pnpm-lock.yaml", "pnpm-workspace.yaml"].map((path) => ({
      status: "M",
      path,
      oldPath: null,
    }));
    const report = createDependencyChangesReport({
      basePayload: { removed: ["1.0.0"], stable: ["1.0.0"], changed: ["1.0.0"] },
      headPayload: { added: ["1.0.0"], stable: ["1.0.0"], changed: ["2.0.0"] },
      dependencyFileChanges,
      generatedAt: "2026-05-12T00:00:00Z",
    });

    expect(report.summary).toEqual({
      basePackages: 3,
      headPackages: 3,
      addedPackages: 1,
      removedPackages: 1,
      changedPackages: 1,
      dependencyFileChanges: 2,
    });
    expect(report.dependencyFileChanges).toEqual([
      { status: "M", path: "pnpm-lock.yaml", oldPath: null },
      { status: "M", path: "pnpm-workspace.yaml", oldPath: null },
    ]);
    expect(report.addedPackages).toEqual([{ packageName: "added", versions: ["1.0.0"] }]);
    expect(report.removedPackages).toEqual([{ packageName: "removed", versions: ["1.0.0"] }]);
    expect(report.changedPackages).toEqual([
      { packageName: "changed", addedVersions: ["2.0.0"], removedVersions: ["1.0.0"] },
    ]);
  });

  it("treats committed dependency locks as dependency files", () => {
    expect(isDependencyFile("pnpm-lock.yaml")).toBe(true);
    expect(isDependencyFile(".github/release/clawhub-cli/package-lock.json")).toBe(true);
    expect(isDependencyFile(".github/release/vercel-cli/package-lock.json")).toBe(true);
    expect(isDependencyFile("extensions/discord/package-lock.json")).toBe(false);
    expect(isDependencyFile("docs/gateway/security/index.md")).toBe(false);
  });

  it("includes committed dependency locks in git diff pathspecs", () => {
    expect(dependencyDiffPathspecs()).toContain("pnpm-lock.yaml");
    expect(dependencyDiffPathspecs()).toContain(".github/release/clawhub-cli/package-lock.json");
    expect(dependencyDiffPathspecs()).toContain(".github/release/vercel-cli/package-lock.json");
  });

  it.each([
    ["--base-ref", "origin/main", "origin/main", null],
    ["--base-lockfile", "base-lock.yaml", null, "base-lock.yaml"],
  ] as const)("parses all report options with %s", (flag, value, baseRef, baseLockfile) => {
    const outputs = "--head-lockfile head.yaml --json r.json -- --markdown r.md".split(" ");
    expect(parseArgs(["--root", "/repo", flag, value, ...outputs])).toEqual({
      rootDir: "/repo",
      baseRef,
      baseLockfile,
      headLockfile: "head.yaml",
      jsonPath: "r.json",
      markdownPath: "r.md",
    });
  });

  it("rejects missing report artifact path option values", () => {
    for (const flag of flags) {
      expect(() => parseArgs([flag, "--json"])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, "-h"])).toThrow(`${flag} requires a value`);
    }
  });

  it("rejects duplicate and conflicting dependency report inputs", () => {
    for (const flag of flags) {
      expect(() => parseArgs(["--base-ref", "main", flag, "one", flag, "two"])).toThrow(
        `${flag} was provided more than once.`,
      );
    }
    expect(() => parseArgs(["--base-ref", "main", "--base-lockfile", "base-lock.yaml"])).toThrow(
      "Use either --base-ref or --base-lockfile, not both.",
    );
  });
});
