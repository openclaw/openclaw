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
function fixture(mode: "native" | "managed" = "native", files = 128) {
  return createProvisionOwnerFixture(tempDirs.make("openclaw-pr-owner-"), mode, files);
}
describePosix("PR worktree interruption", () => {
  it.each(["native", "managed"] as const)(
    "scales the %s checkout deadline with the tree and survives five minutes of progress",
    (mode) => {
      const deadlines: number[] = [];
      for (const files of [128, 256]) {
        const f = fixture(mode, files);
        const receipt = installCheckoutDeadline(f);
        const result = f.run();
        expect(result.status, result.stderr).toBe(0);
        const observed = JSON.parse(readFileSync(receipt, "utf8"));
        expect(observed.elapsed).toBe(300001);
        deadlines.push(observed.deadline);
        expectProvisionSeed(f);
        expect(f.git(f.worktree, "write-tree")).toBe(
          f.git(f.canonical, "rev-parse", `${f.main}^{tree}`),
        );
        expect(f.git(f.canonical, "for-each-ref", "refs/openclaw/pr-operation-locks")).toBe("");
      }
      expect(deadlines[1]).toBeGreaterThan(deadlines[0]!);
    },
  );

  it.each(["retained-gitfile", "removed-gitfile"] as const)(
    "cleans its interrupted checkout (%s) and provisions it again through entry",
    (interruption) => {
      const f = fixture();
      installCheckoutDeadline(f, interruption);
      const interrupted = f.run();
      expect(interrupted.status).not.toBe(0);
      expect(interrupted.stderr).toContain("Git did not finish within its");
      expect(existsSync(f.worktree)).toBe(false);
      expect(existsSync(join(f.canonical, ".git", "worktrees", "pr-42"))).toBe(false);
      expectProvisionLeaseReleased(f);
      const lock = f.git(f.canonical, "rev-parse", "refs/openclaw/pr-operation-locks/42");
      // Only this fixture's joined failed operation is recovered by exact owner.
      delete f.env.NODE_OPTIONS;
      const recovered = f.run("recover", lock);
      expect(recovered.status, recovered.stderr).toBe(0);
      const retried = f.run();
      expect(retried.status, retried.stderr).toBe(0);
      expectProvisionSeed(f);
    },
  );

  it.each(["native", "managed"] as const)(
    "joins slow %s cleanup beyond the former 300 ms force-kill grace",
    (mode) => {
      const f = fixture(mode);
      const receipt = installCheckoutDeadline(f, "slow-cleanup");
      const result = f.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Git did not finish within its");
      expect(readFileSync(join(f.root, "cleanup-complete"), "utf8")).toBe("Git cleanup completed");
      const observed = JSON.parse(readFileSync(receipt, "utf8"));
      expect(observed.cleanupElapsed).toBe(301);
      expect(observed.signals).toContain("SIGTERM");
      expect(observed.signals).not.toContain("SIGKILL");
      expectProvisionLeaseReleased(f);
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

  it("lets interrupted provisioning finish cleanup beyond the supervisor's former five seconds", () => {
    const f = fixture();
    installCheckoutDeadline(f, "external-cancel");
    const result = f.run();
    expect(result.status).not.toBe(0);
    const observed = JSON.parse(readFileSync(join(f.root, "supervisor-grace.json"), "utf8"));
    expect(observed.elapsed).toBe(5001);
    expect(observed.grace).toBeGreaterThan(5001);
    expect(readFileSync(join(f.root, "cleanup-complete"), "utf8")).toBe("Git cleanup completed");
    expect(existsSync(f.worktree)).toBe(false);
    expectProvisionLeaseReleased(f);
    expect(f.git(f.canonical, "rev-parse", "refs/openclaw/pr-operation-locks/42")).toMatch(
      /^[0-9a-f]{40}$/,
    );
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
    expect(readFileSync(join(f.worktree, ".git"), "utf8")).toBe(pointer);
    expect(readFileSync(join(f.worktree, "operator-evidence.txt"), "utf8")).toBe(
      "preserve this checkout\n",
    );
    expect(f.git(f.canonical, "status", "--porcelain")).toBe("");
  });
});
