import { execFileSync } from "node:child_process";
import { devNull } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-test-lines-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => vi.stubEnv("OPENCLAW_RELEASE_CONTEXT_REF", "main"));
afterEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllEnvs());
const record = "config/test-lines-allocations/regression.txt";

function fixture() {
  const files = fixtureFiles(temporary.make("openclaw-test-lines-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: files.root,
      env: { ...createNestedGitEnv(), GIT_CONFIG_GLOBAL: devNull },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "commit");
    return git("rev-parse", "HEAD");
  };
  files.write("base.test.ts", "base\n");
  git("init", "-q");
  const base = commit();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    ...files,
    git,
    commit,
    // The budget counts tracked files only.
    add: (name: string, source: string) => {
      files.write(name, source);
      git("add", name);
    },
    check: (ref = base) => main(files.root, ["--base", ref, "--no-merge-base"]),
  };
}

it("allows 400 net test lines and requires a record for the excess", () => {
  const f = fixture();
  f.add("new.test.ts", "x\n".repeat(400));
  expect(f.check()).toBe(0);
  f.add("new.test.ts", "x\n".repeat(401));
  expect(f.check()).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith(
    expect.stringContaining("Net test lines: +401; allowance: 400; allocation credit: 0."),
  );
  f.add(record, "# Required regression\n1\n");
  expect(f.check()).toBe(0);
  // Merged growth and records never charge or credit a later change.
  const merged = f.commit();
  f.add("next.test.ts", "x\n".repeat(400));
  expect(f.check(merged)).toBe(0);
  expect(console.log).toHaveBeenLastCalledWith(
    "Test lines OK. Net test lines: +400; allowance: 400; allocation credit: 0.",
  );
});

it("skips the budget on release branches", () => {
  vi.stubEnv("OPENCLAW_RELEASE_CONTEXT_REF", "");
  vi.stubEnv("GITHUB_ACTIONS", "");
  const f = fixture();
  f.add("new.test.ts", "x\n".repeat(401));
  f.git("branch", "-m", "release/2026.11.4");
  expect(f.check()).toBe(0);
  expect(console.log).toHaveBeenLastCalledWith("Test-line budget skipped for release branch.");
  f.git("branch", "-m", "main");
  expect(f.check()).toBe(1);
});
