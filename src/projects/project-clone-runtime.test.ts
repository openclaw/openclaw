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

it("preserves an existing checkout when its target cannot be inspected", async () => {
  const target = dirs.make("openclaw-clone-target-");
  const sentinel = path.join(target, "existing.txt");
  await fs.writeFile(sentinel, "existing project data");
  vi.spyOn(fs, "lstat").mockRejectedValueOnce(
    Object.assign(new Error("synthetic target inspection failure"), { code: "EACCES" }),
  );
  const command = mockGit().mockResolvedValue({
    ...failedClone,
    stderr: "fatal: destination path already exists and is not an empty directory",
  });
  const error = await capture(clone(target));
  await expectFile(sentinel, "existing project data");
  expect(error).toBeInstanceOf(ProjectCloneError);
  expect(error).toMatchObject({ failure: "clone_failed" });
  expect(command).not.toHaveBeenCalled();
});

it.each(["success", 0, 128, "throw"] as const)("retains a clone after %s", async (outcome) => {
  const target = targetPath();
  const failure = uncertainFailure();
  const command = mockGit().mockImplementation(async () => {
    await writeArtifact(target, "partial.txt", "owned clone data");
    if (outcome === "throw") {
      throw failure;
    }
    return outcome === "success"
      ? successfulGit
      : { ...failedClone, code: outcome, cleanup: "uncertain" };
  });
  const error = await capture(clone(target));
  await expectFile(path.join(target, "partial.txt"), "owned clone data");
  expect(command).toHaveBeenCalledOnce();
  if (outcome === "success") {
    expect(error).toBeUndefined();
  } else {
    expect(hasCommandProcessCleanupError(error)).toBe(true);
    if (outcome === "throw") {
      expect(error).toHaveProperty("cause", failure);
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

it.each(["probe", "fetch", "repair", "uncertain", "auth"] as const)(
  "settles a pinned checkout after %s",
  async (phase) => {
    const target = targetPath();
    const sentinel = path.join(target, "partial.txt");
    const failure = phase === "uncertain" ? new CommandProcessCleanupError() : uncertainFailure();
    mockGit().mockImplementation(async (argv): Promise<processExec.SpawnResult> => {
      if (argv.includes("clone")) {
        await writeArtifact(target, "partial.txt", "pinned clone data");
        return successfulGit;
      }
      if (phase === "uncertain") {
        throw failure;
      }
      if (phase === "auth") {
        return { ...failedClone, stderr: "Authentication failed" };
      }
      if (argv.includes("rev-list")) {
        return phase === "probe"
          ? gitOutput(pinnedCommit, true)
          : { ...failedClone, stderr: "missing commit" };
      }
      if (argv.includes("fetch")) {
        return phase === "fetch" ? { ...successfulGit, cleanup: "uncertain" } : brokenGraph;
      }
      if (argv.includes("for-each-ref")) {
        throw failure;
      }
      throw new Error("unexpected pinned Git command");
    });

    const error = await capture(clone(target, pinnedCommit));

    if (phase === "auth") {
      expect(error).toBeInstanceOf(ProjectCloneError);
      expect(error).toHaveProperty("failure", "auth_required");
      await expectMissing(target);
    } else {
      expect(hasCommandProcessCleanupError(error)).toBe(true);
      if (phase === "uncertain") {
        expect(error).toBe(failure);
      }
      if (phase === "repair") {
        expect(error).toHaveProperty("cause", failure);
      }
      await expectFile(sentinel, "pinned clone data");
    }
  },
);

it.each(["fetch", "repair", "inventory", "success", "auth failure", "cleanup failure"] as const)(
  "retains or cleans refresh staging after %s",
  async (phase) => {
    const root = dirs.make("openclaw-refresh-cleanup-");
    const target = path.join(root, "checkout");
    const objects = path.join(root, "objects");
    await fs.mkdir(target);
    await fs.mkdir(objects);
    vi.spyOn(os, "tmpdir").mockReturnValue(root);
    const failure = uncertainFailure();
    const cleanupFailure = new Error("synthetic staging removal failure");
    let staging = "";
    let managedInventories = 0;
    const published: (string | Uint8Array | undefined)[] = [];
    mockGit().mockImplementation(async (argv, options): Promise<processExec.SpawnResult> => {
      const cwd = argv[argv.indexOf("-C") + 1];
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
        staging = cwd;
        await fs.writeFile(path.join(staging, "partial.txt"), "owned staging data");
        return successfulGit;
      }
      if (argv.includes("for-each-ref")) {
        if (cwd === target) {
          if (phase === "repair" && managedInventories++ > 0) {
            throw failure;
          }
          return gitOutput(phase === "repair" ? remoteRef : "");
        }
        return gitOutput(remoteRef, phase === "inventory");
      }
      if (argv.includes("update-ref")) {
        if (cwd === staging) {
          return brokenGraph;
        }
        published.push(typeof options === "number" ? undefined : options.input);
        return successfulGit;
      }
      if (argv.includes("fetch")) {
        if (phase === "auth failure") {
          return { ...failedClone, stderr: "Authentication failed" };
        }
        return gitOutput("", phase === "fetch");
      }
      throw new Error("unexpected refresh Git command");
    });
    const remove = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (location, options) => {
      if (phase === "cleanup failure" && location === staging) {
        throw cleanupFailure;
      }
      return remove(location, options);
    });

    const error = await capture(refreshProjectCheckout({ target, url: projectUrl }));

    if (!staging) {
      throw new Error("refresh did not initialize its staging directory");
    }
    if (phase === "fetch" || phase === "repair" || phase === "inventory") {
      expect(hasCommandProcessCleanupError(error)).toBe(true);
      if (phase === "repair") {
        expect(error).toHaveProperty("cause", failure);
      }
      expect(published).toEqual([]);
      await expectFile(path.join(staging, "partial.txt"), "owned staging data");
    } else if (phase === "cleanup failure") {
      expect(error).toBe(cleanupFailure);
      expect(published).toEqual([refUpdate]);
    } else {
      expect(published).toEqual(phase === "success" ? [refUpdate] : []);
      if (phase === "success") {
        expect(error).toBeUndefined();
      } else {
        expect(error).toBeInstanceOf(ProjectCloneError);
        expect(error).toHaveProperty("failure", "auth_required");
      }
      await expectMissing(staging);
    }
  },
);

it.each(["uncertain", "present", "absent"] as const)(
  "observes the remote head when its outcome is %s",
  async (outcome) => {
    const stdout = outcome === "absent" ? "" : `${pinnedCommit}\trefs/heads/main\n`;
    mockGit().mockResolvedValue(gitOutput(stdout, outcome === "uncertain"));
    const observed = readProjectCheckoutRemoteHead({
      target: dirs.make("openclaw-head-cleanup-"),
      url: projectUrl,
      branch: "main",
    });

    if (outcome === "uncertain") {
      await expect(observed).rejects.toBeInstanceOf(CommandProcessCleanupError);
    } else {
      await expect(observed).resolves.toBe(outcome === "present" ? pinnedCommit : undefined);
    }
  },
);
