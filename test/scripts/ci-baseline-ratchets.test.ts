import { afterEach, expect, it, vi } from "vitest";
import { main } from "../../scripts/ci-baseline-ratchets.mts";
import * as managed from "../../scripts/lib/managed-child-process.mts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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

    expect(await main(["--base", "exact-base", "--no-merge-base"])).toBe(1);
    expect(peak).toBe(2);
    expect(running).toBe(0);
    expect(run.mock.calls.map(([command]) => command.args)).toEqual([
      ["check:database-worker-ratchet", "--base", "exact-base", "--no-merge-base"],
      ["check:max-lines-ratchet", "--base", "exact-base", "--no-merge-base"],
      ...(pr ? [["check:line-cap-ratchet", "--base", "exact-base", "--no-merge-base"]] : []),
      ["check:assertion-safety", "--base", "exact-base", "--no-merge-base"],
      ["check:database-dialect-ratchet", "--base", "exact-base", "--no-merge-base"],
      ["check:test-timeout-race-ratchet", "--base", "exact-base", "--no-merge-base"],
      ["check:test-mock-exports", "--base", "exact-base", "--no-merge-base"],
      ["check:test-lines-ratchet", "--base", "exact-base", "--no-merge-base"],
      ["config:docs:check"],
      ["plugins:inventory:check"],
    ]);
  },
);

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
    expect(await main(["--base", "exact-base"])).toBe(exit);
    expect(run).toHaveBeenCalledTimes(2);
    expect(joined).toBe(true);
  },
);
