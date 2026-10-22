import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAuditBounds,
  buildReleasePrepushPlan,
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

  it("keeps the normal zero-delta cut auditable", () => {
    expect(assertAuditBounds(HEAD_SHA, HEAD_SHA)).toBe(HEAD_SHA);
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

  it("uses the audited merge base for gates on a divergent release branch", async () => {
    const runCommand = vi.fn().mockResolvedValue(0);
    const status = await runReleasePrepush(
      { base: "origin/main", dryRun: false, push: false },
      {
        assertCleanWorktree: vi.fn(),
        assertAuditBounds: vi.fn().mockReturnValue(MERGE_BASE_SHA),
        createValidationCheckout: vi.fn().mockReturnValue("/snapshot"),
        currentBranch: vi.fn(),
        pushValidatedHead: vi.fn(),
        refreshMain: vi.fn(),
        refreshReleaseBranch: vi.fn(),
        removeValidationCheckout: vi.fn(),
        resolveCommit: vi.fn((ref) => (ref === "HEAD" ? HEAD_SHA : BASE_SHA)),
        runCommand,
      },
    );
    expect(status).toBe(0);
    expect(runCommand.mock.calls.map(([command]) => [command.bin, command.args])).toEqual([
      ["pnpm", ["install", "--frozen-lockfile"]],
      ["pnpm", ["check:changed", "--base", MERGE_BASE_SHA, "--head", HEAD_SHA]],
      ["pnpm", ["deadcode:knip"]],
      ["node", ["scripts/test-projects.mts", "--changed", MERGE_BASE_SHA]],
    ]);
    expect(runCommand.mock.calls[1]?.[0].env).toMatchObject({
      CHECKOUT_BASE_SHA: MERGE_BASE_SHA,
      OPENCLAW_OXLINT_TRUSTED_POLICY_REF: BASE_SHA,
    });
  });

  it("pins changed static/type checks, dead-code analysis, and changed tests", () => {
    const plan = buildReleasePrepushPlan(BASE_SHA, HEAD_SHA, "/snapshot", { PATH: "/bin" });
    expect(plan.map(({ bin, args }) => [bin, ...args])).toEqual([
      ["pnpm", "install", "--frozen-lockfile"],
      ["pnpm", "check:changed", "--base", BASE_SHA, "--head", HEAD_SHA],
      ["pnpm", "deadcode:knip"],
      ["node", "scripts/test-projects.mts", "--changed", BASE_SHA],
    ]);
    expect(plan.every((command) => command.cwd === "/snapshot")).toBe(true);
    expect(plan[1]?.env).toMatchObject({
      CHECKOUT_BASE_SHA: BASE_SHA,
      CI: "1",
      OPENCLAW_LOCAL_CHECK: "0",
      OPENCLAW_OXLINT_TRUSTED_POLICY_REF: BASE_SHA,
    });
  });

  it("stops at the first failed integrated gate", async () => {
    const runCommand = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(9);
    const removeValidationCheckout = vi.fn();
    const status = await runReleasePrepush(
      { base: "origin/main", dryRun: false, push: false },
      {
        assertCleanWorktree: vi.fn(),
        assertAuditBounds: vi.fn().mockReturnValue(BASE_SHA),
        createValidationCheckout: vi.fn().mockReturnValue("/snapshot"),
        currentBranch: vi.fn(),
        pushValidatedHead: vi.fn(),
        refreshMain: vi.fn(),
        refreshReleaseBranch: vi.fn(),
        removeValidationCheckout,
        resolveCommit: vi.fn((ref) => (ref === "HEAD" ? HEAD_SHA : BASE_SHA)),
        runCommand,
      },
    );
    expect(status).toBe(9);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand.mock.calls.every(([command]) => command.cwd === "/snapshot")).toBe(true);
    expect(removeValidationCheckout).toHaveBeenCalledWith("/snapshot");
  });

  it("rejects a head that changes during validation", async () => {
    const assertCleanWorktree = vi.fn();
    const resolve = vi
      .fn()
      .mockReturnValueOnce(BASE_SHA)
      .mockReturnValueOnce(HEAD_SHA)
      .mockReturnValueOnce("3".repeat(40));
    await expect(
      runReleasePrepush(
        { base: "origin/main", dryRun: false, push: false },
        {
          assertCleanWorktree,
          assertAuditBounds: vi.fn().mockReturnValue(BASE_SHA),
          createValidationCheckout: vi.fn().mockReturnValue("/snapshot"),
          currentBranch: vi.fn(),
          pushValidatedHead: vi.fn(),
          refreshMain: vi.fn(),
          refreshReleaseBranch: vi.fn(),
          removeValidationCheckout: vi.fn(),
          resolveCommit: resolve,
          runCommand: vi.fn().mockResolvedValue(0),
        },
      ),
    ).rejects.toThrow("HEAD changed");
    expect(assertCleanWorktree).toHaveBeenCalledTimes(2);
  });

  it("refreshes main and pushes only the captured SHA to the canonical branch", async () => {
    const refreshMain = vi.fn();
    const pushValidatedHead = vi.fn();
    const runCommand = vi.fn().mockResolvedValue(0);
    const currentBranch = vi.fn().mockReturnValue("release/2026.10.6");
    const status = await runReleasePrepush(
      { base: "origin/main", dryRun: false, push: true },
      {
        assertCleanWorktree: vi.fn(),
        assertAuditBounds: vi
          .fn()
          .mockReturnValueOnce(MERGE_BASE_SHA)
          .mockReturnValueOnce(RELEASE_SHA),
        createValidationCheckout: vi.fn().mockReturnValue("/snapshot"),
        currentBranch,
        pushValidatedHead,
        refreshMain,
        refreshReleaseBranch: vi.fn().mockReturnValue(RELEASE_SHA),
        removeValidationCheckout: vi.fn(),
        resolveCommit: vi.fn((ref) => (ref === "HEAD" ? HEAD_SHA : BASE_SHA)),
        runCommand,
      },
    );
    expect(status).toBe(0);
    expect(refreshMain).toHaveBeenCalledOnce();
    expect(currentBranch).toHaveBeenCalledTimes(2);
    expect(runCommand.mock.calls[1]?.[0].args).toEqual([
      "check:changed",
      "--base",
      RELEASE_SHA,
      "--head",
      HEAD_SHA,
    ]);
    expect(pushValidatedHead).toHaveBeenCalledWith(HEAD_SHA, "release/2026.10.6");
  });

  it("validates and pushes an orchestrator-supplied exact cut to its canonical branch", async () => {
    const pushValidatedHead = vi.fn();
    const currentBranch = vi.fn();
    const resolveCommit = vi.fn((ref) => (ref === "origin/main" ? BASE_SHA : HEAD_SHA));
    const status = await runReleasePrepush(
      {
        base: "origin/main",
        branch: "release/2026.10.6",
        dryRun: false,
        head: HEAD_SHA,
        push: true,
      },
      {
        assertCleanWorktree: vi.fn(),
        assertAuditBounds: vi
          .fn()
          .mockReturnValueOnce(MERGE_BASE_SHA)
          .mockReturnValueOnce(RELEASE_SHA),
        createValidationCheckout: vi.fn().mockReturnValue("/snapshot"),
        currentBranch,
        pushValidatedHead,
        refreshMain: vi.fn(),
        refreshReleaseBranch: vi.fn().mockReturnValue(RELEASE_SHA),
        removeValidationCheckout: vi.fn(),
        resolveCommit,
        runCommand: vi.fn().mockResolvedValue(0),
      },
    );
    expect(status).toBe(0);
    expect(resolveCommit).toHaveBeenCalledWith(HEAD_SHA);
    expect(currentBranch).not.toHaveBeenCalled();
    expect(pushValidatedHead).toHaveBeenCalledWith(HEAD_SHA, "release/2026.10.6");
  });

  it("runs applicable gates and pushes when a fresh cut equals origin/main", async () => {
    const pushValidatedHead = vi.fn();
    const runCommand = vi.fn().mockResolvedValue(0);
    const status = await runReleasePrepush(
      {
        base: "origin/main",
        branch: "release/2026.10.6",
        dryRun: false,
        head: HEAD_SHA,
        push: true,
      },
      {
        assertCleanWorktree: vi.fn(),
        assertAuditBounds,
        createValidationCheckout: vi.fn().mockReturnValue("/snapshot"),
        currentBranch: vi.fn(),
        pushValidatedHead,
        refreshMain: vi.fn(),
        refreshReleaseBranch: vi.fn(),
        removeValidationCheckout: vi.fn(),
        resolveCommit: vi.fn().mockReturnValue(HEAD_SHA),
        runCommand,
      },
    );
    expect(status).toBe(0);
    expect(runCommand).toHaveBeenCalledTimes(4);
    expect(pushValidatedHead).toHaveBeenCalledWith(HEAD_SHA, "release/2026.10.6");
  });

  it("refuses a custom comparison base for a release push", async () => {
    const refreshMain = vi.fn();
    await expect(
      runReleasePrepush(
        { base: "HEAD~1", dryRun: false, push: true },
        {
          assertCleanWorktree: vi.fn(),
          assertAuditBounds: vi.fn(),
          createValidationCheckout: vi.fn(),
          currentBranch: vi.fn().mockReturnValue("release/2026.10.6"),
          pushValidatedHead: vi.fn(),
          refreshMain,
          refreshReleaseBranch: vi.fn(),
          removeValidationCheckout: vi.fn(),
          resolveCommit: vi.fn(),
          runCommand: vi.fn(),
        },
      ),
    ).rejects.toThrow("authoritative origin/main");
    expect(refreshMain).not.toHaveBeenCalled();
  });
});
