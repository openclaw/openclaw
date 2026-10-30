import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = path.join(process.cwd(), "scripts", "apple-release-source-check.sh");
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeRepository(): { root: string; commit: string } {
  const root = tempDirs.make("openclaw-apple-release-source-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet");
  writeFileSync(path.join(root, "tracked.txt"), "clean\n", "utf8");
  git("add", "tracked.txt");
  const config = [
    "commit.gpgsign=false",
    "user.email=release-test@openclaw.test",
    "user.name=OpenClaw Release Test",
  ].flatMap((value) => ["-c", value]);
  git(...config, "commit", "--quiet", "-m", "initial");
  return { root, commit: git("rev-parse", "HEAD").trim() };
}

function runCheck(root: string, commit: string) {
  const args = process.platform === "win32" ? [SCRIPT] : ["--noprofile", "--norc", SCRIPT];
  return spawnSync(BASH_BIN, [...args, "--root", root, "--expected-commit", commit], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

it("accepts a matching full commit from a clean checkout", () => {
  const repository = makeRepository();
  const result = runCheck(repository.root, repository.commit.toUpperCase());

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    `Verified Apple release source: commit=${repository.commit} clean=true`,
  );
});

it("rejects release metadata from a different commit", () => {
  const repository = makeRepository();
  const mismatch = `${repository.commit[0] === "a" ? "b" : "a"}${repository.commit.slice(1)}`;
  const result = runCheck(repository.root, mismatch);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    `Apple release commit mismatch: metadata ${mismatch}, checkout ${repository.commit}.`,
  );
});

it("rejects tracked, staged, and untracked release checkout changes", () => {
  for (const file of ["tracked.txt", "staged.txt", "untracked.txt"]) {
    const repository = makeRepository();
    writeFileSync(path.join(repository.root, file), "dirty\n", "utf8");
    if (file === "staged.txt") {
      execFileSync("git", ["add", file], { cwd: repository.root });
    }
    const result = runCheck(repository.root, repository.commit);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Apple release builds require a clean Git checkout.");
  }
});
