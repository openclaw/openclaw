import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../../scripts/ci-baseline-ratchets.mts";
import * as managed from "../../scripts/lib/managed-child-process.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A repository whose `exact-base` tag precedes one change to `changedPath`. */
function changeSet(changedPath: string) {
  const root = tempDirs.make("openclaw-baseline-ratchets-");
  const { write } = fixtureFiles(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      env: createNestedGitEnv(),
      stdio: "ignore",
    });
  write(changedPath, "export const before = 1;\n");
  git("init");
  git("add", ".");
  git("commit", "-m", "base");
  git("tag", "exact-base");
  write(changedPath, "export const before = 1;\nexport const added = 2;\n");
  git("commit", "-am", "change");
  return root;
}

it.each([false, true])(
  "retains all checks with two slots and PR line-cap selection=%s",
  async (pr) => {
    vi.stubEnv("RATCHET_PR_HEAD_SHA", pr ? "head" : "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let releaseDatabase!: () => void;
    const database = new Promise<void>((resolve) => {
      releaseDatabase = resolve;
    });
    let running = 0;
    let peak = 0;
    const run = vi.spyOn(managed, "runManagedCommand").mockImplementation(async ({ args }) => {
      running += 1;
      peak = Math.max(peak, running);
      if (args?.[0] === "check:database-worker-ratchet") {
        await database;
      } else if (args?.[0] === "plugins:inventory:check") {
        releaseDatabase();
      }
      running -= 1;
      return args?.[0] === "check:max-lines-ratchet" ? 17 : 0;
    });

    const root = changeSet("src/agents/example.ts");
    expect(await main(["--base", "exact-base", "--no-merge-base"], root)).toBe(1);
    expect(peak).toBe(2);
    expect(running).toBe(0);
    expect(run.mock.calls.map(([command]) => command.args)).toEqual([
      ["check:database-worker-ratchet", "--base", "exact-base", "--no-merge-base"],
      ["check:max-lines-ratchet", "--base", "exact-base", "--no-merge-base"],
      ...(pr ? [["check:line-cap-ratchet", "--base", "exact-base", "--no-merge-base"]] : []),
      ["check:assertion-safety", "--base", "exact-base", "--no-merge-base"],
      ["check:database-dialect-ratchet", "--base", "exact-base", "--no-merge-base"],
      ["check:session-identity-ratchet", "--base", "exact-base", "--no-merge-base"],
      ["check:provider-branching-ratchet", "--base", "exact-base", "--no-merge-base"],
      ["check:runtime-process-lifecycle", "--base", "exact-base", "--no-merge-base"],
      ["check:test-timeout-race-ratchet", "--base", "exact-base", "--no-merge-base"],
      ["check:test-mock-exports", "--base", "exact-base", "--no-merge-base"],
      ["check:test-lines-ratchet", "--base", "exact-base", "--no-merge-base"],
      ["config:docs:check"],
      ["plugins:inventory:check"],
    ]);
  },
);

it.each([
  ["src/plugin-sdk/agent-harness-runtime.ts", true],
  ["src/agents/example.ts", false],
])("runs the SDK export and surface budget checks when %s changes: %s", async (path, sdk) => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const run = vi.spyOn(managed, "runManagedCommand").mockResolvedValue(0);
  await main(["--base", "exact-base", "--no-merge-base"], changeSet(path));
  const ran = new Set(run.mock.calls.map(([command]) => command.args?.[0]));
  expect(ran.has("plugin-sdk:check-exports")).toBe(sdk);
  expect(ran.has("plugin-sdk:surface:check")).toBe(sdk);
});

it.each([124, 137])(
  "joins the active sibling and stops admitting checks after exit %s",
  async (exit) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let joined = false;
    const run = vi
      .spyOn(managed, "runManagedCommand")
      .mockImplementation(async ({ args, signal }) => {
        if (args?.[0] === "check:database-worker-ratchet") {
          return exit;
        }
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve());
        });
        joined = true;
        return 143;
      });
    expect(
      await main(["--base", "exact-base", "--no-merge-base"], changeSet("src/agents/example.ts")),
    ).toBe(exit);
    expect(run).toHaveBeenCalledTimes(2);
    expect(joined).toBe(true);
  },
);
