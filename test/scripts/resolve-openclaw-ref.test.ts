import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/github/resolve-openclaw-ref.sh";
const tempDirs = createTempDirTracker();
let remoteRepo: string;
let remoteSha: string;

afterAll(() => {
  tempDirs.cleanup();
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRemoteRepo() {
  const repo = tempDirs.make("openclaw-ref-remote-");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test-user"]);
  git(repo, ["config", "user.name", "Test User"]);
  execFileSync("bash", ["-c", "printf seed > seed.txt"], { cwd: repo });
  git(repo, ["add", "seed.txt"]);
  git(repo, ["commit", "-qm", "seed"]);
  const sha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["branch", "release/test"]);
  git(repo, ["branch", "ambiguous"]);
  git(repo, ["-c", "tag.gpgSign=false", "tag", "v2026.6.21"]);
  git(repo, ["-c", "tag.gpgSign=false", "tag", "ambiguous"]);
  return { repo, sha };
}

beforeAll(() => {
  ({ repo: remoteRepo, sha: remoteSha } = createRemoteRepo());
});

function runResolver(remote: string, args: string[]) {
  return spawnSync("bash", [SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: "",
      OPENCLAW_REF_REMOTE: remote,
    },
  });
}

function expectOutput(output: string, kind: string, fallback = false) {
  expect(output.trim().split("\n").filter(Boolean).toSorted()).toEqual([
    `fallback=${fallback}`,
    `fast=${!fallback}`,
    `ref_kind=${kind}`,
    `sha=${remoteSha}`,
  ]);
}

function expectResolved(args: string[], ref_kind: string, fallback = false) {
  const result = runResolver(remoteRepo, args);
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expectOutput(result.stdout, ref_kind, fallback);
}

function expectRejected(result: ReturnType<typeof runResolver>, error: string) {
  expect(result).toMatchObject({ status: 1, stdout: "" });
  expect(result.stderr).toContain(error);
}

describe("scripts/github/resolve-openclaw-ref.sh", () => {
  it("resolves branch and tag refs with git ls-remote", () => {
    expectResolved(["--ref", "release/test"], "branch");
    expectResolved(["--ref", "v2026.6.21"], "tag");
  });

  it("accepts full commit SHA refs without remote lookup", () => {
    expectResolved(["--ref", remoteSha.toUpperCase()], "sha", true);
  });

  it("writes fallback outputs for unresolved refs when a caller supplies an expected SHA", () => {
    const outputPath = join(tempDirs.make("openclaw-ref-output-"), "github-output.txt");
    const result = runResolver(remoteRepo, [
      "--ref",
      "missing-ref",
      "--expected-sha",
      remoteSha,
      "--fallback-ok",
      "--github-output",
      outputPath,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expectOutput(execFileSync("cat", [outputPath], { encoding: "utf8" }), "unknown", true);
  });

  it("does not let fallback mode hide remote lookup failures", () => {
    const missingRemote = join(tempDirs.make("openclaw-ref-missing-"), "missing.git");
    const result = runResolver(missingRemote, [
      "--ref",
      "missing-ref",
      "--expected-sha",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "--fallback-ok",
    ]);

    expectRejected(result, "does not appear to be a git repository");
  });

  it("rejects ambiguous branch and tag names before emitting outputs", () => {
    const result = runResolver(remoteRepo, ["--ref", "ambiguous"]);

    expectRejected(result, "Ref resolved ambiguously as both branch and tag: ambiguous");
  });

  it("rejects a branch whose resolved SHA differs from expected_sha before emitting outputs", () => {
    const expectedSha = "b".repeat(40);
    const result = runResolver(remoteRepo, [
      "--ref",
      "release/test",
      "--expected-sha",
      expectedSha,
    ]);
    expect(result).toMatchObject({
      status: 1,
      stdout: "",
      stderr: `Ref release/test resolved to ${remoteSha}, expected ${expectedSha}.\n`,
    });
  });
});
