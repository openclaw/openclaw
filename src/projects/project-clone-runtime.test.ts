import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
  recordCommandProcessFailure,
} from "../process/exec-result.js";
import * as processExec from "../process/exec.js";
import {
  cloneProjectCheckout,
  ProjectCloneError,
  readProjectCheckoutRemoteHead,
  refreshProjectCheckout,
} from "./project-clone-runtime.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const projectUrl = "https://github.com/example/project.git";
const pinnedCommit = "a".repeat(40);
const remoteRef = `refs/remotes/origin/main ${pinnedCommit}`;
const refUpdate = `update ${remoteRef}\n`;
const failedClone: processExec.SpawnResult = {
  code: 128,
  stdout: "",
  stderr: "fatal: unable to access repository: The requested URL returned error: 503",
  termination: "exit",
  signal: null,
  killed: false,
};
const successfulGit: processExec.SpawnResult = { ...failedClone, code: 0, stderr: "" };
const gitOutput = (stdout = "", uncertain = false): processExec.SpawnResult => ({
  ...successfulGit,
  stdout,
  cleanup: uncertain ? "uncertain" : undefined,
});
const brokenGraph = {
  ...failedClone,
  stderr: "which is in the commit graph file but not in the object database",
};
const capture = (pending: Promise<unknown>) => pending.catch((error: unknown) => error);
const mockGit = () => vi.spyOn(processExec, "runCommandWithTimeout");
const targetPath = () => path.join(dirs.make("openclaw-clone-"), "checkout");
const clone = (target: string, requiredCommit?: string) =>
  cloneProjectCheckout({ url: projectUrl, target, requiredCommit });
const expectFile = (file: string, content: string) =>
  expect(fs.readFile(file, "utf8")).resolves.toBe(content);
const expectMissing = (file: string) =>
  expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
async function writeArtifact(target: string, name: string, content: string, recursive = false) {
  await fs.mkdir(target, { recursive });
  await fs.writeFile(path.join(target, name), content);
}
function uncertainFailure() {
  return recordCommandProcessFailure(new Error("synthetic capture failure"), {
    code: null,
    termination: "signal",
    cleanup: "uncertain",
  });
}

it.each([
  "uninspectable",
  "clone-result",
  "clone-throw",
  "pin-throw",
  "pin-repair",
  "pin-auth",
  "refresh-fetch",
  "refresh-auth",
  "refresh-cleanup",
] as const)("settles project artifacts after %s", async (mode) => {
  const target = targetPath();
  const refreshing = mode.startsWith("refresh-");
  const pinned = mode.startsWith("pin-");
  const root = path.dirname(target);
  const objects = path.join(root, "objects");
  const failure = mode === "pin-throw" ? new CommandProcessCleanupError() : uncertainFailure();
  const cleanupFailure = new Error("synthetic staging removal failure");
  let artifactDir = target;
  const published: (string | Uint8Array | undefined)[] = [];
  if (refreshing) {
    await fs.mkdir(target);
    await fs.mkdir(objects);
    vi.spyOn(os, "tmpdir").mockReturnValue(root);
  } else if (mode === "uninspectable") {
    await writeArtifact(target, "partial.txt", "owned artifact");
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(
      Object.assign(new Error("synthetic target inspection failure"), { code: "EACCES" }),
    );
  }
  const command = mockGit().mockImplementation(
    async (argv, options): Promise<processExec.SpawnResult> => {
      const cwd = argv[argv.indexOf("-C") + 1];
      if (refreshing) {
        if (argv.includes("--git-path")) {
          return gitOutput(objects);
        }
        if (argv.includes("--show-object-format")) {
          return gitOutput("sha1");
        }
        if (argv.includes("config")) {
          return { ...successfulGit, code: 1 };
        }
        if (argv.includes("init") && cwd) {
          artifactDir = cwd;
          await fs.writeFile(path.join(cwd, "partial.txt"), "owned artifact");
          return successfulGit;
        }
        if (argv.includes("for-each-ref")) {
          return gitOutput(cwd === target ? "" : remoteRef);
        }
        if (argv.includes("update-ref") && cwd === target) {
          published.push(typeof options === "number" ? undefined : options.input);
          return successfulGit;
        }
      } else {
        if (argv.includes("clone")) {
          await writeArtifact(target, "partial.txt", "owned artifact");
          if (mode === "clone-throw") {
            throw failure;
          }
          return pinned ? successfulGit : { ...failedClone, cleanup: "uncertain" };
        }
        if (mode === "pin-throw" || argv.includes("for-each-ref")) {
          throw failure;
        }
        if (argv.includes("rev-list")) {
          return {
            ...failedClone,
            stderr: mode === "pin-auth" ? "Authentication failed" : "missing commit",
          };
        }
      }
      if (argv.includes("fetch")) {
        if (mode.endsWith("-auth")) {
          return { ...failedClone, stderr: "Authentication failed" };
        }
        return refreshing ? gitOutput("", mode === "refresh-fetch") : brokenGraph;
      }
      throw new Error("unexpected project Git command");
    },
  );
  if (mode === "refresh-cleanup") {
    const remove = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (location, options) => {
      if (location === artifactDir) {
        throw cleanupFailure;
      }
      return remove(location, options);
    });
  }
  const error = await capture(
    refreshing
      ? refreshProjectCheckout({ target, url: projectUrl })
      : clone(target, pinned ? pinnedCommit : undefined),
  );
  if (refreshing) {
    expect(artifactDir).not.toBe(target);
    expect(published).toEqual(mode === "refresh-cleanup" ? [refUpdate] : []);
  }
  if (mode.endsWith("-auth")) {
    expect(error).toBeInstanceOf(ProjectCloneError);
    expect(error).toHaveProperty("failure", "auth_required");
    await expectMissing(artifactDir);
  } else if (mode === "refresh-cleanup") {
    expect(error).toBe(cleanupFailure);
  } else {
    await expectFile(path.join(artifactDir, "partial.txt"), "owned artifact");
    if (mode === "uninspectable") {
      expect(error).toBeInstanceOf(ProjectCloneError);
      expect(error).toHaveProperty("failure", "clone_failed");
      expect(command).not.toHaveBeenCalled();
    } else {
      expect(hasCommandProcessCleanupError(error)).toBe(true);
      if (mode === "pin-throw") {
        expect(error).toBe(failure);
      }
      if (mode === "clone-throw" || mode === "pin-repair") {
        expect(error).toHaveProperty("cause", failure);
      }
      if (!pinned && !refreshing) {
        expect(command).toHaveBeenCalledOnce();
      }
    }
  }
});

it.each([false, true])(
  "retries only after partial cleanup settles (removal fails: %s)",
  async (fails) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const target = targetPath();
    const partial = path.join(target, "partial.txt");
    let attempts = 0;
    const command = mockGit().mockImplementation(async () => {
      if (attempts++ === 0) {
        await writeArtifact(target, "partial.txt", "partial clone", fails);
        return failedClone;
      }
      await expectMissing(target);
      await writeArtifact(target, "README.md", "retried checkout");
      return { ...failedClone, code: 0, stderr: "" };
    });
    const remove = fs.rm;
    const removed = Promise.withResolvers<void>();
    vi.spyOn(fs, "rm").mockImplementation(async (location, options) => {
      if (location === target && fails) {
        removed.resolve();
        throw Object.assign(new Error("synthetic cleanup failure"), { code: "EACCES" });
      }
      await remove(location, options);
      if (location === target) {
        removed.resolve();
      }
    });
    const pending = capture(clone(target));
    await removed.promise;
    await vi.runAllTimersAsync();
    const error = await pending;
    if (fails) {
      await expectFile(partial, "partial clone");
      expect(error).toBeInstanceOf(ProjectCloneError);
      expect(error).toMatchObject({
        failure: "clone_failed",
        message: expect.stringContaining("remove the partial checkout"),
      });
    } else {
      expect(error).toBeUndefined();
      await expectFile(path.join(target, "README.md"), "retried checkout");
      await expectMissing(partial);
    }
    expect(command).toHaveBeenCalledTimes(fails ? 1 : 2);
  },
);

it.each(["present", "absent"] as const)(
  "observes the remote head when its outcome is %s",
  async (outcome) => {
    const stdout = outcome === "absent" ? "" : `${pinnedCommit}\trefs/heads/main\n`;
    mockGit().mockResolvedValue(gitOutput(stdout));
    const observed = readProjectCheckoutRemoteHead({
      target: dirs.make("openclaw-head-cleanup-"),
      url: projectUrl,
      branch: "main",
    });

    await expect(observed).resolves.toBe(outcome === "present" ? pinnedCommit : undefined);
  },
);
