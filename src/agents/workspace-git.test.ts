import { execFile } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { ensureGitRepo, findGitCheckoutRoot, hasWorkspaceGitCheckout } from "./workspace-git.js";

afterEach(async () => {
  await drainGlobalSingletonLifecycleState("shared-state");
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.useRealTimers();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("retains workspace Git presentation while current admission and external changes stay visible", async () => {
  const workspace = tempDirs.make("workspace-git-projection-");
  const metadata = path.join(workspace, ".git");
  const stat = vi.spyOn(fs.promises, "stat");
  syncBuiltinESMExports();
  expect(await findGitCheckoutRoot(workspace)).toBeNull();
  expect(stat).toHaveBeenCalled();
  expect(await hasWorkspaceGitCheckout(workspace)).toBe(false);
  stat.mockClear();
  for (let i = 0; i < 10; i++) {
    expect(await hasWorkspaceGitCheckout(workspace)).toBe(false);
  }
  expect(stat).not.toHaveBeenCalled();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  expect(await hasWorkspaceGitCheckout(workspace)).toBe(false);
  expect(stat).not.toHaveBeenCalled();
  vi.mocked(Date.now).mockRestore();

  await promisify(execFile)(process.execPath, [
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], 'gitdir: missing-worktree\\n')",
    metadata,
  ]);
  expect(await findGitCheckoutRoot(workspace)).toBe(workspace);
  await vi.waitFor(async () => expect(await hasWorkspaceGitCheckout(workspace)).toBe(true));

  await promisify(execFile)(process.execPath, [
    "-e",
    "require('node:fs').unlinkSync(process.argv[1])",
    metadata,
  ]);
  expect(await findGitCheckoutRoot(workspace)).toBeNull();
  await vi.waitFor(async () => expect(await hasWorkspaceGitCheckout(workspace)).toBe(false));

  await ensureGitRepo(workspace, true);
  expect(await hasWorkspaceGitCheckout(workspace)).toBe(true);
});

it("keeps periodic presentation and fresh admission off synchronous filesystem APIs", async () => {
  const workspace = tempDirs.make("workspace-git-main-thread-");
  await fs.promises.writeFile(path.join(workspace, ".git"), "gitdir: missing-worktree\n");
  await hasWorkspaceGitCheckout(workspace);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  const sync = [
    vi.spyOn(fs, "existsSync"),
    vi.spyOn(fs, "statSync"),
    vi.spyOn(fs, "lstatSync"),
    vi.spyOn(fs, "readdirSync"),
  ];
  syncBuiltinESMExports();
  for (let i = 0; i < 10; i++) {
    expect(await hasWorkspaceGitCheckout(workspace)).toBe(true);
    expect(await findGitCheckoutRoot(workspace)).toBe(workspace);
  }
  for (const call of sync) {
    expect(call).not.toHaveBeenCalled();
  }
});

it("invalidates nested checkout presentation when an ancestor alias or Git marker changes", async () => {
  const root = tempDirs.make("workspace-git-alias-");
  const repository = path.join(root, "repository");
  const plain = path.join(root, "plain");
  const alias = path.join(root, "alias");
  await fs.promises.mkdir(path.join(repository, "nested"), { recursive: true });
  await fs.promises.mkdir(path.join(plain, "nested"), { recursive: true });
  await fs.promises.writeFile(path.join(repository, ".git"), "gitdir: missing-worktree\n");
  await fs.promises.symlink(repository, alias, "junction");
  const workspace = path.join(alias, "nested");
  expect(await hasWorkspaceGitCheckout(workspace)).toBe(true);
  expect(await hasWorkspaceGitCheckout(path.join(plain, "nested"))).toBe(false);
  await fs.promises.unlink(alias);
  await fs.promises.symlink(plain, alias, "junction");
  await vi.waitFor(async () => expect(await hasWorkspaceGitCheckout(workspace)).toBe(false));
  await fs.promises.mkdir(path.join(root, ".git"));
  expect(await findGitCheckoutRoot(workspace)).toBeNull();
  await fs.promises.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await vi.waitFor(async () => expect(await hasWorkspaceGitCheckout(workspace)).toBe(true));
  expect(await hasWorkspaceGitCheckout(path.join(plain, "nested"))).toBe(true);
});
