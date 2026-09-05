import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SpawnResult } from "../../process/exec.js";
import * as processExec from "../../process/exec.js";
import * as windowsCommand from "../../process/windows-command.js";
import {
  commandError,
  findGitCheckoutRoot,
  hasSelfContainedGitMetadata,
  insideGitCheckout,
  listGitWorktrees,
  runGit,
} from "./git.js";

it("preserves worktree identity and foreign locks from MSYS porcelain paths", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  const success = {
    code: 0,
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
  try {
    vi.spyOn(fsSync, "existsSync").mockImplementation((file) =>
      String(file).endsWith("msys-2.0.dll"),
    );
    vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue({
      ...success,
      stdout: "worktree /c/repo\0\0worktree /d/linked checkout\0locked other owner\0\0",
    });
    vi.spyOn(windowsCommand, "resolveSafeChildProcessInvocation").mockReturnValue({
      command: "C:\\msys64\\usr\\bin\\git.exe",
      args: [],
      usesWindowsExitCodeShim: false,
      windowsHide: true,
    });
    vi.spyOn(processExec, "runUtf8CommandWithTimeout").mockImplementation(async (argv) => ({
      ...success,
      stdout: argv.at(-1) === "/c/repo" ? "C:\\repo\n" : "D:\\linked checkout\n",
    }));
    await expect(listGitWorktrees("C:\\repo")).resolves.toEqual([
      { path: "C:\\repo" },
      { path: "D:\\linked checkout", lockedReason: "other owner" },
    ]);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("Git checkout discovery", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("reports a real Git failure with execution metadata through the worktree wrapper", async () => {
    const root = tempDirs.make("openclaw-git-error-");
    const result = await runGit(path.join(root, "missing"), ["status"]);

    expectTypeOf(result).toMatchTypeOf<SpawnResult>();
    expect(result.timeoutMs).toBe(120_000);
    expect(result.code).toBe(128);
    expect(result).toMatchObject({ termination: "exit", signal: null });
    const message = commandError("git status", result).message;
    expect(message).toContain("git status failed (exit code 128)");
    expect(message).toContain("fatal:");
    expect(message).not.toMatch(/timeout|timed out/i);
  });

  it("returns the nearest checkout root for nested paths", async () => {
    const root = tempDirs.make("openclaw-git-root-");
    const nested = path.join(root, "packages", "nested");
    await fs.mkdir(path.join(root, ".git"));
    await fs.mkdir(nested, { recursive: true });

    expect(findGitCheckoutRoot(nested)).toBe(root);
    expect(insideGitCheckout(nested)).toBe(true);
  });

  it("returns null outside a checkout", async () => {
    const root = tempDirs.make("openclaw-no-git-root-");

    expect(findGitCheckoutRoot(root)).toBeNull();
    expect(insideGitCheckout(root)).toBe(false);
  });

  it("distinguishes contained metadata from linked checkout pointers", async () => {
    const root = tempDirs.make("openclaw-git-metadata-");
    await fs.mkdir(path.join(root, ".git"));
    await expect(hasSelfContainedGitMetadata(root)).resolves.toBe(true);

    await fs.rm(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git"), "gitdir: /outside/worktrees/card\n", "utf8");
    await expect(hasSelfContainedGitMetadata(root)).resolves.toBe(false);
  });
});
