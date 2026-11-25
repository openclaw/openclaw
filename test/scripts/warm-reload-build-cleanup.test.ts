import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { failManagedCleanup } from "../../scripts/lib/managed-cleanup-handoff.mts";
import { prepareWarmReloadBuild } from "../../scripts/perf/warm-reload-compare.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const state = vi.hoisted(() => ({ repository: "", failure: new Error("build failed") }));
const temporary = useAutoCleanupTempDirTracker(afterEach);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  // Exercise real worktree creation/removal in a disposable repository, never
  // the source checkout containing this test or another developer's worktree.
  const execFile = ((
    file: string,
    args: string[],
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) =>
    actual.execFile(file, ["-C", state.repository, ...args], callback)) as typeof actual.execFile;
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: string[]) =>
      promisify(actual.execFile)(file, ["-C", state.repository, ...args]),
  });
  return { ...actual, execFile };
});
vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: async () => {
    throw state.failure;
  },
}));
vi.mock("../../scripts/lib/managed-cleanup-handoff.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-cleanup-handoff.mts")>()),
  // Simulated unjoined work has no real child; do not poison the test runner's
  // actual parent claim while checking the build owner's retention decision.
  failManagedCleanup: vi.fn(),
}));

it.each(["joined", "unjoined"] as const)(
  "preserves correct worktree custody after a %s command failure",
  async (cleanup) => {
    vi.mocked(failManagedCleanup).mockClear();
    await mkdir(".local", { recursive: true });
    const root = temporary.make("reload-build-cleanup-", path.resolve(".local"));
    state.repository = path.join(root, "repository");
    execFileSync("git", ["init", "--quiet", state.repository]);
    execFileSync("git", [
      "-C",
      state.repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Fixture",
    ]);
    state.failure =
      cleanup === "unjoined"
        ? Object.assign(new Error("fixture command cleanup is unverified"), {
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processTreeState: "indeterminate",
          })
        : new Error("fixture build failed after command cleanup");
    const directory = path.join(root, "proof");
    await expect(prepareWarmReloadBuild("HEAD", { directory, label: "base" })).rejects.toBe(
      state.failure,
    );
    const checkout = path.join(directory, "base-source");
    expect(existsSync(checkout)).toBe(cleanup === "unjoined");
    const worktrees = execFileSync(
      "git",
      ["-C", state.repository, "worktree", "list", "--porcelain", "-z"],
      {
        encoding: "utf8",
      },
    );
    const registered = worktrees
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => path.normalize(field.slice("worktree ".length)));
    expect(registered.includes(checkout)).toBe(cleanup === "unjoined");
    expect(failManagedCleanup).toHaveBeenCalledTimes(cleanup === "unjoined" ? 1 : 0);
  },
);
