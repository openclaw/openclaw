import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareTestboxLeaseFreshness,
  recordTestboxLeaseFreshness,
  testboxLeaseStaleReasons,
} from "../../scripts/testbox-lease-freshness.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const fingerprint = {
  version: 1,
  baseSha: "a".repeat(40),
  headSha: "d".repeat(40),
  workingTreeClean: true,
  dependencyDigest: "b".repeat(64),
  environmentDigest: "c".repeat(64),
  workflow: ".github/workflows/ci-check-testbox.yml",
  job: "check",
  ref: "main",
};

describe("Testbox lease freshness", () => {
  it("rejects reuse after only the wrapper implementation changes", () => {
    const root = tempDirs.make("openclaw-testbox-freshness-");
    const repoRoot = join(root, "repo");
    mkdirSync(join(repoRoot, "scripts"), { recursive: true });
    const implementation = join(repoRoot, "scripts/crabbox-wrapper.mts");
    writeFileSync(implementation, "// initial implementation\n");
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: repoRoot,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        stdio: "pipe",
      });
    git(["init", "-q"]);
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    const request = {
      args: ["run", "--id", "tbx_fixture"],
      provider: "blacksmith-testbox",
      repoRoot,
      env: { OPENCLAW_TESTBOX_LEASE_STATE_DIR: join(root, "receipts") },
    };
    recordTestboxLeaseFreshness(prepareTestboxLeaseFreshness(request));
    writeFileSync(join(repoRoot, "source.txt"), "source-only edits may reuse\n");
    expect(() => prepareTestboxLeaseFreshness(request)).not.toThrow();
    writeFileSync(implementation, "// changed bootstrap implementation\n");
    expect(() => prepareTestboxLeaseFreshness(request)).toThrow("environmentDigest");
  });

  it("reuses a lease when hydrated inputs still match", () => {
    expect(testboxLeaseStaleReasons(fingerprint, { ...fingerprint })).toEqual([]);
  });

  it("rotates a lease when base, dependency, or workflow inputs drift", () => {
    expect(
      testboxLeaseStaleReasons(fingerprint, {
        ...fingerprint,
        baseSha: "d".repeat(40),
        dependencyDigest: "e".repeat(64),
        workflow: "other.yml",
      }),
    ).toEqual(["baseSha", "dependencyDigest", "workflow"]);
  });

  it("rejects unknown provenance schemas", () => {
    expect(testboxLeaseStaleReasons({ ...fingerprint, version: 2 }, fingerprint)).toEqual([
      "state schema",
    ]);
  });
});
