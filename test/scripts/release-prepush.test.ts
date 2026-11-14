import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAuditBounds,
  parseReleasePrepushArgs,
  runReleasePrepush,
  selectChangedGateBase,
} from "../../scripts/release-prepush.mts";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const MERGE_BASE_SHA = "3".repeat(40);
const RELEASE_SHA = "4".repeat(40);

afterEach(() => {
  vi.restoreAllMocks();
});

function fixture() {
  const deps = {
    assertCleanWorktree: vi.fn(),
    assertAuditBounds: vi.fn().mockReturnValue(BASE_SHA),
    currentBranch: vi.fn().mockReturnValue("release/2026.10.6"),
    pushValidatedHead: vi.fn(),
    refreshMain: vi.fn(),
    refreshReleaseBranch: vi.fn(),
    resolveCommit: vi.fn((ref: string) => (ref === "origin/main" ? BASE_SHA : HEAD_SHA)),
    runCommand: vi
      .fn<NonNullable<Parameters<typeof runReleasePrepush>[1]>["runCommand"]>()
      .mockResolvedValue(0),
  };
  return {
    deps,
    run: (options: Partial<Parameters<typeof runReleasePrepush>[0]> = {}) =>
      runReleasePrepush({ base: "origin/main", dryRun: false, push: false, ...options }, deps),
  };
}

describe("release:prepush", () => {
  it("accepts the package-script separator after its injected push flag", () => {
    expect(
      parseReleasePrepushArgs([
        "--push",
        "--",
        "--head",
        HEAD_SHA,
        "--branch",
        "release/2026.10.6",
      ]),
    ).toMatchObject({
      branch: "release/2026.10.6",
      head: HEAD_SHA,
      push: true,
    });
    expect(() => parseReleasePrepushArgs(["--push", "--", "--", "--head", HEAD_SHA])).toThrow(
      "unknown argument: --",
    );
  });

  it("accepts the exact package-script CLI shape at the executable boundary", () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "scripts/release-prepush.mts", "--push", "--", "--help"],
      { encoding: "utf8" },
    );
    expect(output).toContain("Usage: pnpm release:prepush");
  });

  it("selects the canonical release head in a real divergent Git history", () => {
    const repo = mkdtempSync(join(tmpdir(), "openclaw-release-baseline-"));
    const git = (args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    try {
      git(["init", "--quiet", "--initial-branch=main"]);
      git(["config", "user.name", "Release Test"]);
      git(["config", "user.email", "release-test@example.com"]);
      git(["commit", "--quiet", "--allow-empty", "-m", "shared"]);
      git(["branch", "release/2026.10.6"]);
      git(["commit", "--quiet", "--allow-empty", "-m", "main only"]);
      const mainSha = git(["rev-parse", "HEAD"]);
      git(["switch", "--quiet", "release/2026.10.6"]);
      git(["commit", "--quiet", "--allow-empty", "-m", "published release"]);
      const releaseSha = git(["rev-parse", "HEAD"]);
      git(["commit", "--quiet", "--allow-empty", "-m", "candidate"]);
      const candidateSha = git(["rev-parse", "HEAD"]);

      expect(
        selectChangedGateBase(mainSha, candidateSha, releaseSha, (baseSha, headSha) =>
          git(["merge-base", baseSha, headSha]),
        ),
      ).toBe(releaseSha);
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  it("rejects a candidate that does not advance the canonical release branch", () => {
    const mergeBase = vi
      .fn()
      .mockReturnValueOnce(MERGE_BASE_SHA)
      .mockReturnValueOnce(MERGE_BASE_SHA);
    expect(() => selectChangedGateBase(BASE_SHA, HEAD_SHA, RELEASE_SHA, mergeBase)).toThrow(
      "not a fast-forward",
    );
  });

  it("uses the audited merge base for the short preflight on a divergent release branch", async () => {
    const { deps, run } = fixture();
    deps.assertAuditBounds.mockReturnValue(MERGE_BASE_SHA);
    expect(await run()).toBe(0);
    expect(deps.runCommand.mock.calls.map(([command]) => [command.bin, command.args])).toEqual([
      ["git", ["diff", "--check", MERGE_BASE_SHA, HEAD_SHA]],
      ["node", ["scripts/release-changelog.mjs", "check", "--ref", HEAD_SHA]],
    ]);
    expect(deps.runCommand.mock.calls.every(([command]) => command.cwd === process.cwd())).toBe(
      true,
    );
  });

  it("stops at the first failed integrated gate", async () => {
    const { deps, run } = fixture();
    deps.runCommand.mockResolvedValueOnce(0).mockResolvedValueOnce(9);
    expect(await run()).toBe(9);
    expect(deps.runCommand).toHaveBeenCalledTimes(2);
  });

  it("rejects a head that changes during validation", async () => {
    const { deps, run } = fixture();
    deps.resolveCommit
      .mockReturnValueOnce(BASE_SHA)
      .mockReturnValueOnce(HEAD_SHA)
      .mockReturnValueOnce("3".repeat(40));
    await expect(run()).rejects.toThrow("HEAD changed");
    expect(deps.assertCleanWorktree).toHaveBeenCalledTimes(2);
  });

  it("refreshes main and pushes only the captured SHA to the canonical branch", async () => {
    const { deps, run } = fixture();
    deps.assertAuditBounds.mockReturnValueOnce(MERGE_BASE_SHA).mockReturnValueOnce(RELEASE_SHA);
    deps.refreshReleaseBranch.mockReturnValue(RELEASE_SHA);
    expect(await run({ push: true })).toBe(0);
    expect(deps.refreshMain).toHaveBeenCalledOnce();
    expect(deps.currentBranch).toHaveBeenCalledTimes(2);
    expect(deps.runCommand.mock.calls[0]?.[0].args).toEqual([
      "diff",
      "--check",
      RELEASE_SHA,
      HEAD_SHA,
    ]);
    expect(deps.pushValidatedHead).toHaveBeenCalledWith(HEAD_SHA, "release/2026.10.6");
  });

  it("validates and pushes an orchestrator-supplied exact cut to its canonical branch", async () => {
    const { deps, run } = fixture();
    deps.assertAuditBounds.mockReturnValueOnce(MERGE_BASE_SHA).mockReturnValueOnce(RELEASE_SHA);
    deps.refreshReleaseBranch.mockReturnValue(RELEASE_SHA);
    expect(await run({ branch: "release/2026.10.6", head: HEAD_SHA, push: true })).toBe(0);
    expect(deps.resolveCommit).toHaveBeenCalledWith(HEAD_SHA);
    expect(deps.currentBranch).not.toHaveBeenCalled();
    expect(deps.pushValidatedHead).toHaveBeenCalledWith(HEAD_SHA, "release/2026.10.6");
  });

  it("runs applicable gates and pushes when a fresh cut equals origin/main", async () => {
    const { deps, run } = fixture();
    deps.assertAuditBounds.mockImplementation(assertAuditBounds);
    deps.resolveCommit.mockReturnValue(HEAD_SHA);
    expect(await run({ branch: "release/2026.10.6", head: HEAD_SHA, push: true })).toBe(0);
    expect(deps.runCommand).toHaveBeenCalledTimes(2);
    expect(deps.pushValidatedHead).toHaveBeenCalledWith(HEAD_SHA, "release/2026.10.6");
  });

  it("refuses a custom comparison base for a release push", async () => {
    const { deps, run } = fixture();
    await expect(run({ base: "HEAD~1", push: true })).rejects.toThrow("authoritative origin/main");
    expect(deps.refreshMain).not.toHaveBeenCalled();
  });
});
