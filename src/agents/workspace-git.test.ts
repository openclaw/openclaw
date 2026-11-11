import { execFile } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensureGitRepo, findGitCheckoutRoot, hasWorkspaceGitCheckout } from "./workspace-git.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.useRealTimers();
});

it("retains workspace Git presentation while current admission and external changes stay visible", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const workspace = tempDirs.make("workspace-git-projection-");
  const metadata = path.join(workspace, ".git");
  const exists = vi.spyOn(fs, "existsSync");
  syncBuiltinESMExports();
  expect(findGitCheckoutRoot(workspace)).toBeNull();
  expect(exists).toHaveBeenCalled();
  expect(hasWorkspaceGitCheckout(workspace)).toBe(false);
  exists.mockClear();
  for (let i = 0; i < 10; i++) {
    expect(hasWorkspaceGitCheckout(workspace)).toBe(false);
  }
  expect(exists).not.toHaveBeenCalled();

  await promisify(execFile)(process.execPath, [
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], 'gitdir: missing-worktree\\n')",
    metadata,
  ]);
  expect(findGitCheckoutRoot(workspace)).toBe(workspace);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(hasWorkspaceGitCheckout(workspace)).toBe(true);

  await promisify(execFile)(process.execPath, [
    "-e",
    "require('node:fs').unlinkSync(process.argv[1])",
    metadata,
  ]);
  expect(findGitCheckoutRoot(workspace)).toBeNull();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(hasWorkspaceGitCheckout(workspace)).toBe(false);

  await ensureGitRepo(workspace, true);
  expect(hasWorkspaceGitCheckout(workspace)).toBe(true);
});
