import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createProvisionOwnerFixture,
  expectProvisionSeed,
  expectProvisionLeaseReleased,
} from "./pr-worktree-owner.test-support.js";
import { installCheckoutDeadline } from "./pr-worktree-provision.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const read = (...parts: string[]) => readFileSync(join(...parts), "utf8");
const readJson = (...parts: string[]) => JSON.parse(read(...parts));
function fixture(mode: "native" | "managed" = "native", files = 128) {
  return createProvisionOwnerFixture(tempDirs.make("openclaw-pr-owner-"), mode, files);
}
describePosix("PR worktree interruption", () => {
  it("scales the native checkout deadline with the tree and survives five minutes of progress", () => {
    const deadlines: number[] = [];
    for (const files of [128, 256]) {
      const f = fixture("native", files);
      const receipt = installCheckoutDeadline(f);
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      const observed = readJson(receipt);
      expect(observed.elapsed).toBe(300001);
      deadlines.push(observed.deadline);
      expectProvisionSeed(f);
      expect(f.git(f.worktree, "write-tree")).toBe(
        f.git(f.canonical, "rev-parse", `${f.main}^{tree}`),
      );
      expect(f.git(f.canonical, "for-each-ref", "refs/openclaw/pr-operation-locks")).toBe("");
    }
    expect(deadlines[1]).toBeGreaterThan(deadlines[0]!);
  });

  it.each([
    { mode: "native", interruption: "retained-gitfile" },
    { mode: "native", interruption: "removed-gitfile" },
    { mode: "native", interruption: "slow-cleanup" },
    { mode: "managed", interruption: "slow-cleanup" },
    { mode: "native", interruption: "external-cancel" },
  ] as const)(
    "joins $mode $interruption cleanup without losing ownership",
    ({ mode, interruption }) => {
      const f = fixture(mode);
      const receipt = installCheckoutDeadline(f, interruption);
      const result = f.run();
      expect(result.status).not.toBe(0);
      expectProvisionLeaseReleased(f);
      if (interruption !== "external-cancel") {
        expect(result.stderr).toContain("Git did not finish within its");
      }
      if (interruption === "slow-cleanup" || interruption === "external-cancel") {
        expect(read(f.root, "cleanup-complete")).toBe("Git cleanup completed");
        const observed = readJson(
          interruption === "slow-cleanup" ? receipt : join(f.root, "supervisor-grace.json"),
        );
        if (interruption === "slow-cleanup") {
          expect(observed).toMatchObject({
            cleanupElapsed: 301,
            signals: expect.arrayContaining(["SIGTERM"]),
          });
          expect(observed.signals).not.toContain("SIGKILL");
        } else {
          expect(observed.elapsed).toBe(5001);
          expect(observed.grace).toBeGreaterThan(5001);
          expect(existsSync(f.worktree)).toBe(false);
          expect(f.git(f.canonical, "rev-parse", "refs/openclaw/pr-operation-locks/42")).toMatch(
            /^[0-9a-f]{40}$/,
          );
        }
      } else {
        expect(
          [f.worktree, join(f.canonical, ".git", "worktrees", "pr-42")].map(existsSync),
        ).toEqual([false, false]);
        expect(result.stderr).toContain("Released the operation lock for PR #42 after exit code");
        expect(f.git(f.canonical, "for-each-ref", "refs/openclaw/pr-operation-locks")).toBe("");
        delete f.env.NODE_OPTIONS;
        const retried = f.run();
        expect(retried.status, retried.stderr).toBe(0);
        expectProvisionSeed(f);
      }
    },
  );

  it("removes its empty reservation after Git rejects a seed already owned by a sibling", () => {
    const f = fixture();
    installCheckoutDeadline(f, "rejected");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/already (?:checked out|used by worktree)/);
    expect(existsSync(f.worktree)).toBe(false);
    const sibling = join(f.root, "seed-sibling");
    expect(f.git(sibling, "symbolic-ref", "HEAD")).toBe("refs/heads/temp/pr-42");
    expect(f.git(sibling, "rev-parse", "HEAD")).toBe(f.main);
  });

  it("refuses a foreign damaged checkout without modifying its evidence", () => {
    const f = fixture();
    mkdirSync(f.worktree, { recursive: true });
    const pointer = `gitdir: ${join(f.canonical, ".git", "worktrees", "pr-42")}\n`;
    writeFileSync(join(f.worktree, ".git"), pointer);
    writeFileSync(join(f.worktree, "operator-evidence.txt"), "preserve this checkout\n");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("damaged worktree metadata");
    expect([read(f.worktree, ".git"), read(f.worktree, "operator-evidence.txt")]).toEqual([
      pointer,
      "preserve this checkout\n",
    ]);
    expect(f.git(f.canonical, "status", "--porcelain")).toBe("");
  });
});
