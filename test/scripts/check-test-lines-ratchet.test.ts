import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { devNull } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-test-lines-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const baseline = "config/test-lines-baseline.txt";
const allocation = (name: string) => `config/test-lines-allocations/${name}.txt`;

function fixture(initial: Record<string, string>) {
  const files = fixtureFiles(temporary.make("openclaw-test-lines-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: files.root,
      env: { ...createNestedGitEnv(), GIT_CONFIG_GLOBAL: devNull },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = (message: string) => {
    git("add", ".");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  for (const [name, source] of Object.entries(initial)) {
    files.write(name, source);
  }
  git("init", "-q");
  const base = commit("base");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return {
    ...files,
    git,
    commit,
    base,
    check: (args: string[] = [], ref = base) =>
      main(files.root, ["--base", ref, "--no-merge-base", ...args]),
  };
}

it("counts tracked test lines, gates net growth, and only prunes the ceiling downward", () => {
  const files = [
    ...["ts", "tsx", "mts", "mjs", "js", "cjs"].map((extension) => `a.test.${extension}`),
    "a.test-support.ts",
    "nested/test-support/test-helpers.test.js",
    "nested/test-support/data.txt",
  ];
  const { write, read, check } = fixture({
    ...Object.fromEntries(files.map((file) => [file, "x".repeat(65535) + "\r\ntwo\nunterminated"])),
    "production.ts": "ignored\n",
    [baseline]: "18\n",
  });
  write("untracked.test.ts", "ignored\n");
  expect(check()).toBe(0);
  expect(console.log).toHaveBeenLastCalledWith("Test lines OK: 18; ceiling: 18; slack: 0.");
  write("a.test.ts", "one\ntwo\nthree\nfour\n");
  expect(check()).toBe(1);
  expect(check(["--prune"])).toBe(1);
  expect(read(baseline)).toBe("18\n");
  expect(check(["--staged"])).toBe(0);
  write(baseline, "16\n");
  write("a.test.ts", "one\n");
  expect(check()).toBe(0);
  expect(console.log).toHaveBeenLastCalledWith(
    expect.stringContaining("over by: 1; net delta: -1."),
  );
  expect(check(["--prune"])).toBe(1);
  write(baseline, "19\n");
  expect(check()).toBe(0);
  expect(console.warn).toHaveBeenLastCalledWith(
    "Test line ceiling raised manually: 18 -> 19; justify this in the PR.",
  );
  expect(console.log).toHaveBeenLastCalledWith("Test lines OK: 17; ceiling: 19; slack: 2.");
  expect(check(["--prune"])).toBe(0);
  expect(read(baseline)).toBe("17\n");
});

it.each(["first", "second"])("merges independent allocations with %s first", (first) => {
  const f = fixture({ [baseline]: "2\n", "base.test.ts": "one\ntwo\n" });
  for (const branch of ["first", "second"]) {
    f.git("checkout", "-qb", branch, f.base);
    f.write(`${branch}.test.ts`, "new\n");
    f.write(allocation(branch), "# Required regression\n1\n");
    f.commit(branch);
    expect(f.check()).toBe(0);
  }
  f.git("checkout", "-q", first);
  f.git("merge", "--no-edit", first === "first" ? "second" : "first");
  expect(f.check()).toBe(0);
  expect(console.log).toHaveBeenLastCalledWith("Test lines OK: 4; ceiling: 4; slack: 0.");
  f.write("first.test.ts", "new\nunallocated\n");
  expect(f.check()).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith(
    expect.stringContaining("over by: 1; net delta: +3."),
  );
});

it("rejects separate grants for overlapping test growth", () => {
  const f = fixture({ [baseline]: "1\n", "base.test.ts": "base\n" });
  for (const branch of ["first", "second"]) {
    f.git("checkout", "-qb", branch, f.base);
    f.write("shared.test.ts", "same\n");
    f.write(allocation(branch), "1\n");
    f.commit(branch);
    expect(f.check()).toBe(0);
  }
  f.git("merge", "--no-edit", "first");
  expect(f.check()).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith(
    "Test line allocation credit 2 exceeds added test lines 1.",
  );
});

it("bounds renamed allocations with scalar changes but ignores comment-only edits", () => {
  const f = fixture({
    [baseline]: "1\n",
    [allocation("old")]: "1\n",
    "base.test.ts": "one\ntwo\n",
  });
  f.git("mv", allocation("old"), allocation("new"));
  f.write(baseline, "2\n");
  expect(f.check()).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith(
    "Test line allocation credit 1 exceeds added test lines 0.",
  );
  f.write(baseline, "1\n");
  expect(f.check()).toBe(0);
  const renamed = f.commit("rename allocation");
  f.write(allocation("new"), "# Same credit\n1\n");
  f.write(baseline, "2\n");
  expect(f.check([], renamed)).toBe(0);
  expect(console.warn).toHaveBeenLastCalledWith(
    "Test line ceiling raised manually: 2 -> 3; justify this in the PR.",
  );
});

it("measures literal LF growth and does not forgive inherited debt", () => {
  const f = fixture({ [baseline]: "0\n", "base.test.ts": "x" });
  f.write("base.test.ts", "x\n");
  expect(f.check()).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith(expect.stringContaining("net delta: +1."));
  f.commit("inherited debt");
  const debt = f.git("rev-parse", "HEAD");
  f.write("new.test.ts", "new\n");
  f.write(allocation("new"), "1\n");
  f.git("add", ".");
  expect(f.check([], debt)).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith(
    expect.stringContaining("Test lines: 2; ceiling: 1; over by: 1; net delta: +1."),
  );
});

it("uses exact index snapshots and ignores untracked or deleted allocation files", () => {
  const f = fixture({ [baseline]: "1\n", "base.test.ts": "base\n" });
  f.write("new.test.ts", "new\n");
  f.write(allocation("new"), "1\n");
  f.git("add", ".");
  f.write(allocation("untracked"), "999\n");
  expect(f.check()).toBe(0);
  f.write(allocation("new"), "2\n");
  expect(f.check()).toBe(1);
  expect(f.check(["--staged"])).toBe(0);
  fs.unlinkSync(f.file(allocation("new")));
  expect(f.check()).toBe(1);
  expect(f.check(["--staged"])).toBe(0);
  expect(f.check(["--staged", "--prune"])).toBe(1);
  expect(f.read(baseline)).toBe("1\n");
});

it.each([5, 25])(
  "does not reuse folded credit when an old branch adds %i lines of grant",
  (grant) => {
    const f = fixture({
      [baseline]: "100\n",
      [allocation("old")]: "20\n",
      "base.test.ts": "old\n".repeat(120),
    });
    f.git("checkout", "-qb", "old-branch");
    f.write("new.test.ts", "new\n".repeat(5));
    f.write(allocation("new"), `${grant}\n`);
    f.commit("new regression");
    f.git("checkout", "-qb", "pruned", f.base);
    expect(f.check(["--prune"])).toBe(0);
    expect(f.read(baseline)).toBe("120\n");
    expect(fs.existsSync(f.file(allocation("old")))).toBe(false);
    const pruned = f.commit("prune");
    expect(f.check()).toBe(0);
    expect(console.warn).not.toHaveBeenCalled();
    f.git("merge", "--no-edit", "old-branch");
    expect(f.check()).toBe(grant === 5 ? 0 : 1);
    expect(f.check([], pruned)).toBe(grant === 5 ? 0 : 1);
    if (grant === 5) {
      f.write(allocation("untracked"), "999\n");
      expect(f.check(["--prune"])).toBe(0);
      expect(f.read(baseline)).toBe("125\n");
      expect(fs.existsSync(f.file(allocation("new")))).toBe(false);
      expect(f.read(allocation("untracked"))).toBe("999\n");
    } else {
      expect(console.error).toHaveBeenLastCalledWith(
        "Test line allocation credit 25 exceeds added test lines 5.",
      );
    }
  },
);

it("rejects malformed allocation values and unsafe aggregate ceilings", () => {
  const f = fixture({ [baseline]: "1\n", "base.test.ts": "base\n" });
  f.write(allocation("invalid"), "0\n");
  f.git("add", ".");
  for (const value of ["-1", "word", "1\n2", "9007199254740992"]) {
    f.write(allocation("invalid"), value);
    expect(f.check()).toBe(1);
    expect(console.error).toHaveBeenLastCalledWith(expect.stringContaining("must contain"));
  }
  f.write(allocation("invalid"), "9007199254740991\n");
  expect(f.check()).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith("Test line ceiling exceeds a safe integer");
});
