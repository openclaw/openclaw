import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/github/resolve-openclaw-ref.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let remoteRepo: string;
let remoteSha: string;

beforeAll(() => {
  const repo = tempDirs.make("openclaw-ref-remote-");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test-user");
  git("config", "user.name", "Test User");
  writeFileSync(join(repo, "seed.txt"), "seed");
  git("add", "seed.txt");
  git("commit", "-qm", "seed");
  for (const ref of ["release/test", "ambiguous"]) {
    git("branch", ref);
  }
  for (const ref of ["v2026.6.21", "ambiguous"]) {
    git("-c", "tag.gpgSign=false", "tag", ref);
  }
  remoteRepo = repo;
  remoteSha = git("rev-parse", "HEAD");
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

it.each([
  ["branch", "release/test"],
  ["tag", "v2026.6.21"],
  ["sha", null],
] as const)("resolves %s refs", (kind, ref) => {
  const result = runResolver(remoteRepo, ["--ref", ref ?? remoteSha.toUpperCase()]);
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expectOutput(result.stdout, kind, ref === null);
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

  expect(result).toMatchObject({ status: 0, stdout: "" });
  expectOutput(readFileSync(outputPath, "utf8"), "unknown", true);
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

  expect(result).toMatchObject({
    status: 1,
    stdout: "",
    stderr: expect.stringContaining("does not appear to be a git repository"),
  });
});

it("rejects ambiguous branch and tag names before emitting outputs", () => {
  const result = runResolver(remoteRepo, ["--ref", "ambiguous"]);

  expect(result).toMatchObject({
    status: 1,
    stdout: "",
    stderr: expect.stringContaining("Ref resolved ambiguously as both branch and tag: ambiguous"),
  });
});

it("rejects a branch whose resolved SHA differs from expected_sha before emitting outputs", () => {
  const expectedSha = "b".repeat(40);
  const result = runResolver(remoteRepo, ["--ref", "release/test", "--expected-sha", expectedSha]);
  expect(result).toMatchObject({
    status: 1,
    stdout: "",
    stderr: `Ref release/test resolved to ${remoteSha}, expected ${expectedSha}.\n`,
  });
});
