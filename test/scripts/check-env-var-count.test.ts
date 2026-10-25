import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectEnvVarNames, main } from "../../scripts/check-env-var-count.mts";
import { withEnv } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const budgetPath = "config/env-var-count-budget.txt";
const gitIdentity = ["-c", "user.name=OpenClaw", "-c", "user.email=test@openclaw.local"];
beforeEach(() => vi.stubEnv("GITHUB_ACTIONS", ""));
afterEach(() => vi.unstubAllEnvs());

function createRepo(files: Record<string, string> = {}, initialCount?: number) {
  const root = tempDirs.make("openclaw-env-count-");
  const git = (args: string[]) =>
    execFileSync("git", [...gitIdentity, ...args], { cwd: root }).toString();
  const write = (file: string, source: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  };
  git(["init"]);
  Object.entries(files).forEach(([file, source]) => write(file, source));
  const commit = (message = "base") => {
    git(["add", "."]);
    git(["commit", "-m", message]);
  };
  const setCount = (count: number, budget = count) => {
    write(budgetPath, `${budget}\n`);
    write("src/runtime.ts", Array.from({ length: count }, (_, i) => `OPENCLAW_N${i}`).join("\n"));
  };
  if (initialCount !== undefined) {
    setCount(initialCount);
    commit();
  }
  const check = (...args: string[]) => main(args, root);
  const collect = (staged = false) => collectEnvVarNames(root, { staged });
  return { root, git, write, commit, setCount, check, collect };
}

it("blocks unrecorded CI names while recorded budget growth only warns", () => {
  const { root, check, write } = createRepo({}, 0);
  write("src/runtime.ts", "process.env.OPENCLAW_CANARY;\n");
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv("GITHUB_STEP_SUMMARY", path.join(root, "summary.md"));
  expect(() => check("--base", "HEAD")).toThrow(/count 1 exceeds budget 0/u);
  write(budgetPath, "1\n");
  expect(check("--base", "HEAD")).toBe(1);
  expect(fs.readFileSync(path.join(root, "summary.md"), "utf8")).toContain("grew from 0 to 1");
  vi.stubEnv("GITHUB_ACTIONS", "");
  expect(() => check("--base", "HEAD")).toThrow(/budget grew from 0 to 1/u);
  write(budgetPath, "invalid\n");
  expect(() => check("--base", "HEAD")).toThrow(/non-negative integer/u);
});

it("keeps an empty index separate from untracked worktree sources", () => {
  const { collect, write } = createRepo();
  expect(collect(true)).toEqual([]);
  write("src/runtime.ts", "OPENCLAW_UNTRACKED");
  expect([collect(true), collect()]).toEqual([[], ["OPENCLAW_UNTRACKED"]]);
});

it("collects distinct names from the whole selected snapshot without crossing file boundaries", () => {
  const excludedPaths = [
    "src/runtime.test.ts src/__tests__/index.ts packages/api/test/index.ts",
    "extensions/demo/index.spec.ts extensions/qa-lab/index.ts extensions/test-support/index.ts",
    "src/runtime.json ui/src/runtime.ts",
  ].flatMap((paths) => paths.split(" "));
  const { root, git, write, commit, collect } = createRepo({
    ".gitignore": "src/ignored.ts\n",
    "src/partial.ts": "OPENCLAW_HEAD",
    "src/modified.ts": "OPENCLAW_OLD",
    "src/removed.ts": "OPENCLAW_REMOVED",
    "src/gone.ts": "OPENCLAW_GONE",
    "src/empty.ts": "",
    "src/boundary-a.ts": "OPENCLAW_",
    "src/boundary-b.ts": "BOUNDARY_TRAP",
    "src/unchanged.ts": "é 🦞 東京\nOPENCLAW_SHARED\0OPENCLAW_UNICODE",
    "packages/api/index.mts": "OPENCLAW_SHARED OPENCLAW_SHARED",
    "extensions/demo/index.cjs": "OPENCLAW_PLUGIN",
    ...Object.fromEntries(excludedPaths.map((file) => [file, "OPENCLAW_EXCLUDED"])),
  });
  commit();
  write("src/partial.ts", "OPENCLAW_INDEX");
  write("src/modified.ts", "OPENCLAW_MODIFIED");
  write("src/added.ts", "OPENCLAW_ADDED");
  git(["add", "."]);
  write("src/partial.ts", "OPENCLAW_WORKTREE");
  write("src/added.ts", "OPENCLAW_UNSTAGED_ADDITION");
  git(["rm", "--cached", "src/removed.ts"]);
  fs.rmSync(path.join(root, "src/gone.ts"));
  write("src/untracked.ts", "OPENCLAW_UNTRACKED");
  write("src/ignored.ts", "OPENCLAW_IGNORED");

  const names = (...keys: string[]) => keys.map((key) => `OPENCLAW_${key}`).toSorted();
  const shared = ["MODIFIED", "PLUGIN", "SHARED", "UNICODE"];
  expect(collect(true)).toEqual(names(...shared, "ADDED", "GONE", "INDEX"));
  expect(collect()).toEqual(
    names(...shared, "REMOVED", "UNSTAGED_ADDITION", "UNTRACKED", "WORKTREE"),
  );
});

it("uses a constant number of Git processes as the staged source set grows", () => {
  const counts = [8, 16].map((fileCount) => {
    const names = Array.from({ length: fileCount }, (_, index) => `OPENCLAW_N${index}`);
    const { root, git, collect } = createRepo(
      Object.fromEntries(names.map((name, index) => [`src/file-${index}.ts`, name])),
    );
    git(["add", "."]);
    const traceFile = path.join(root, "git-trace.jsonl");
    const collected = withEnv({ GIT_TRACE2_EVENT: traceFile }, () => collect(true));
    expect(collected).toEqual(names.toSorted());
    const events = fs.readFileSync(traceFile, "utf8").trim().split("\n");
    return events.filter((event) => JSON.parse(event).event === "start").length;
  });
  expect(Math.min(...counts)).toBeGreaterThan(0);
  expect(Math.max(...counts)).toBeLessThanOrEqual(2);
  expect(new Set(counts).size).toBe(1);
});

it("allows the initial budget only when its file is absent at a valid base", () => {
  const { check, commit, write } = createRepo({ "src/runtime.ts": "OPENCLAW_ONE" });
  commit("before budget");
  write(budgetPath, "1\n");
  expect(check("--base", "HEAD")).toBe(1);
});

it("compares staged budgets to the origin/main fork rather than local HEAD", () => {
  const { check, git, setCount, commit } = createRepo({}, 1);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  setCount(2);
  commit("local budget increase");
  expect(() => check("--staged")).toThrow(/budget grew/u);
  expect(check("--staged", "--base", "HEAD")).toBe(2);
});

it("rejects stale headroom in the staged budget", () => {
  const { check, git, setCount } = createRepo({}, 2);
  setCount(1, 2);
  git(["add", "."]);
  setCount(0);
  expect(() => check("--staged", "--base", "HEAD")).toThrow(/is below budget/u);
});
