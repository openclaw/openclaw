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

it("preserves an existing checkout when its target cannot be inspected", async () => {
  const target = dirs.make("openclaw-clone-target-");
  const sentinel = path.join(target, "existing.txt");
  await fs.writeFile(sentinel, "existing project data");
  vi.spyOn(fs, "lstat").mockRejectedValueOnce(
    Object.assign(new Error("synthetic target inspection failure"), { code: "EACCES" }),
  );
  const command = vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue({
    code: 128,
    stdout: "",
    stderr: "fatal: destination path already exists and is not an empty directory",
    termination: "exit",
    signal: null,
    killed: false,
  });

  const error = await cloneProjectCheckout({
    url: "https://github.com/example/project.git",
    target,
  }).catch((failure: unknown) => failure);

  await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("existing project data");
  expect(error).toBeInstanceOf(ProjectCloneError);
  expect(error).toMatchObject({ failure: "clone_failed" });
  expect(command).not.toHaveBeenCalled();
});

it("clones into a genuinely missing target", async () => {
  const target = path.join(dirs.make("openclaw-clone-absent-"), "checkout");
  vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async () => {
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "README.md"), "cloned project");
    return {
      code: 0,
      stdout: "",
      stderr: "",
      termination: "exit",
      signal: null,
      killed: false,
    };
  });

  await cloneProjectCheckout({ url: "https://github.com/example/project.git", target });

  await expect(fs.readFile(path.join(target, "README.md"), "utf8")).resolves.toBe("cloned project");
});

const failedClone: processExec.SpawnResult = {
  code: 128,
  stdout: "",
  stderr: "fatal: unable to access repository: The requested URL returned error: 503",
  termination: "exit",
  signal: null,
  killed: false,
};

it.each([0, 128])(
  "preserves the checkout when Git cleanup is uncertain (exit %s)",
  async (code) => {
    const target = path.join(dirs.make("openclaw-clone-unsettled-"), "checkout");
    const sentinel = path.join(target, "partial.txt");
    const command = vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async () => {
      await fs.mkdir(target);
      await fs.writeFile(sentinel, "owned clone data");
      return { ...failedClone, code, cleanup: "uncertain" };
    });

    const error = await cloneProjectCheckout({
      url: "https://github.com/example/project.git",
      target,
    }).catch((failure: unknown) => failure);

    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("owned clone data");
    expect(hasCommandProcessCleanupError(error)).toBe(true);
    expect(command).toHaveBeenCalledOnce();
  },
);

it("surfaces failed partial-checkout removal without retrying Git", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const target = path.join(dirs.make("openclaw-clone-cleanup-"), "checkout");
  const sentinel = path.join(target, "partial.txt");
  const command = vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async () => {
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(sentinel, "partial clone");
    return failedClone;
  });
  const remove = fs.rm;
  const removalAttempted = Promise.withResolvers<void>();
  vi.spyOn(fs, "rm").mockImplementation(async (location, options) => {
    if (location === target) {
      removalAttempted.resolve();
      throw Object.assign(new Error("synthetic cleanup failure"), { code: "EACCES" });
    }
    return remove(location, options);
  });

  const pending = cloneProjectCheckout({
    url: "https://github.com/example/project.git",
    target,
  }).catch((failure: unknown) => failure);
  await removalAttempted.promise;
  await vi.runAllTimersAsync();
  const error = await pending;

  await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("partial clone");
  expect(error).toBeInstanceOf(ProjectCloneError);
  expect(error).toMatchObject({ failure: "clone_failed" });
  expect(error).toHaveProperty("message", expect.stringContaining("remove the partial checkout"));
  expect(command).toHaveBeenCalledOnce();
});

it("removes a settled partial checkout before the normal network retry", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const target = path.join(dirs.make("openclaw-clone-retry-"), "checkout");
  const partial = path.join(target, "partial.txt");
  let attempts = 0;
  const command = vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async () => {
    if (attempts++ === 0) {
      await fs.mkdir(target);
      await fs.writeFile(partial, "partial clone");
      return failedClone;
    }
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "README.md"), "retried checkout");
    return { ...failedClone, code: 0, stderr: "" };
  });
  const remove = fs.rm;
  const removed = Promise.withResolvers<void>();
  vi.spyOn(fs, "rm").mockImplementation(async (location, options) => {
    await remove(location, options);
    if (location === target) {
      removed.resolve();
    }
  });

  const pending = cloneProjectCheckout({ url: "https://github.com/example/project.git", target });
  await removed.promise;
  await vi.runAllTimersAsync();
  await pending;

  await expect(fs.readFile(path.join(target, "README.md"), "utf8")).resolves.toBe(
    "retried checkout",
  );
  await expect(fs.lstat(partial)).rejects.toMatchObject({ code: "ENOENT" });
  expect(command).toHaveBeenCalledTimes(2);
});

const projectUrl = "https://github.com/example/project.git";
const pinnedCommit = "a".repeat(40);
const successfulGit: processExec.SpawnResult = { ...failedClone, code: 0, stderr: "" };

it("retains a clone when its thrown failure records uncertain cleanup", async () => {
  const target = path.join(dirs.make("openclaw-clone-recorded-"), "checkout");
  const sentinel = path.join(target, "partial.txt");
  const failure = recordCommandProcessFailure(new Error("synthetic capture failure"), {
    code: null,
    termination: "signal",
    cleanup: "uncertain",
  });
  const command = vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async () => {
    await fs.mkdir(target);
    await fs.writeFile(sentinel, "owned clone data");
    throw failure;
  });

  const error = await cloneProjectCheckout({ url: projectUrl, target }).catch(
    (caught: unknown) => caught,
  );

  expect(hasCommandProcessCleanupError(error)).toBe(true);
  expect(error).toHaveProperty("cause", failure);
  await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("owned clone data");
  expect(command).toHaveBeenCalledOnce();
});

it.each(["probe", "fetch", "repair"] as const)(
  "retains a pinned checkout after uncertain %s work",
  async (phase) => {
    const target = path.join(dirs.make("openclaw-pinned-cleanup-"), "checkout");
    const sentinel = path.join(target, "partial.txt");
    const failure = recordCommandProcessFailure(new Error("synthetic repair capture failure"), {
      code: null,
      termination: "signal",
      cleanup: "uncertain",
    });
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(
      async (argv): Promise<processExec.SpawnResult> => {
        if (argv.includes("clone")) {
          await fs.mkdir(target);
          await fs.writeFile(sentinel, "pinned clone data");
          return successfulGit;
        }
        if (argv.includes("rev-list")) {
          return phase === "probe"
            ? { ...successfulGit, stdout: pinnedCommit, cleanup: "uncertain" }
            : { ...failedClone, stderr: "missing commit" };
        }
        if (argv.includes("fetch")) {
          return phase === "fetch"
            ? { ...successfulGit, cleanup: "uncertain" }
            : {
                ...failedClone,
                stderr: "which is in the commit graph file but not in the object database",
              };
        }
        if (argv.includes("for-each-ref")) {
          throw failure;
        }
        throw new Error("unexpected pinned Git command");
      },
    );

    const error = await cloneProjectCheckout({
      url: projectUrl,
      target,
      requiredCommit: pinnedCommit,
    }).catch((caught: unknown) => caught);

    expect(hasCommandProcessCleanupError(error)).toBe(true);
    if (phase === "repair") {
      expect(error).toHaveProperty("cause", failure);
    }
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("pinned clone data");
  },
);

it.each(["uncertain", "settled auth failure"] as const)(
  "cleans or preserves a pinned checkout after %s",
  async (outcome) => {
    const target = path.join(dirs.make("openclaw-pinned-outcome-"), "checkout");
    const sentinel = path.join(target, "partial.txt");
    const failure = new CommandProcessCleanupError();
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv) => {
      if (argv.includes("clone")) {
        await fs.mkdir(target);
        await fs.writeFile(sentinel, "pinned clone data");
        return successfulGit;
      }
      if (outcome === "uncertain") {
        throw failure;
      }
      return { ...failedClone, stderr: "Authentication failed" };
    });

    const error = await cloneProjectCheckout({
      url: projectUrl,
      target,
      requiredCommit: pinnedCommit,
    }).catch((caught: unknown) => caught);

    if (outcome === "uncertain") {
      expect(error).toBe(failure);
      await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("pinned clone data");
    } else {
      expect(error).toBeInstanceOf(ProjectCloneError);
      expect(error).toHaveProperty("failure", "auth_required");
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
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
    const failure = recordCommandProcessFailure(new Error("synthetic repair capture failure"), {
      code: null,
      termination: "signal",
      cleanup: "uncertain",
    });
    const cleanupFailure = new Error("synthetic staging removal failure");
    let staging = "";
    let managedInventories = 0;
    const published: (string | Uint8Array | undefined)[] = [];
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(
      async (argv, options): Promise<processExec.SpawnResult> => {
        const cwd = argv[argv.indexOf("-C") + 1];
        if (argv.includes("--git-path")) {
          return { ...successfulGit, stdout: objects };
        }
        if (argv.includes("--show-object-format")) {
          return { ...successfulGit, stdout: "sha1" };
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
            return {
              ...successfulGit,
              stdout: phase === "repair" ? `refs/remotes/origin/main ${pinnedCommit}` : "",
            };
          }
          return {
            ...successfulGit,
            stdout: `refs/remotes/origin/main ${pinnedCommit}`,
            cleanup: phase === "inventory" ? "uncertain" : undefined,
          };
        }
        if (argv.includes("update-ref")) {
          if (cwd === staging) {
            return {
              ...failedClone,
              stderr: "which is in the commit graph file but not in the object database",
            };
          }
          published.push(typeof options === "number" ? undefined : options.input);
          return successfulGit;
        }
        if (argv.includes("fetch")) {
          if (phase === "auth failure") {
            return { ...failedClone, stderr: "Authentication failed" };
          }
          return {
            ...successfulGit,
            cleanup: phase === "fetch" ? "uncertain" : undefined,
          };
        }
        throw new Error("unexpected refresh Git command");
      },
    );
    const remove = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (location, options) => {
      if (phase === "cleanup failure" && location === staging) {
        throw cleanupFailure;
      }
      return remove(location, options);
    });

    const error = await refreshProjectCheckout({ target, url: projectUrl }).catch(
      (caught: unknown) => caught,
    );

    if (!staging) {
      throw new Error("refresh did not initialize its staging directory");
    }
    if (phase === "fetch" || phase === "repair" || phase === "inventory") {
      expect(hasCommandProcessCleanupError(error)).toBe(true);
      if (phase === "repair") {
        expect(error).toHaveProperty("cause", failure);
      }
      expect(published).toEqual([]);
      await expect(fs.readFile(path.join(staging, "partial.txt"), "utf8")).resolves.toBe(
        "owned staging data",
      );
    } else if (phase === "cleanup failure") {
      expect(error).toBe(cleanupFailure);
      expect(published).toEqual([`update refs/remotes/origin/main ${pinnedCommit}\n`]);
    } else {
      expect(published).toEqual(
        phase === "success" ? [`update refs/remotes/origin/main ${pinnedCommit}\n`] : [],
      );
      if (phase === "success") {
        expect(error).toBeUndefined();
      } else {
        expect(error).toBeInstanceOf(ProjectCloneError);
        expect(error).toHaveProperty("failure", "auth_required");
      }
      await expect(fs.lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

it.each(["uncertain", "present", "absent"] as const)(
  "observes the remote head when its outcome is %s",
  async (outcome) => {
    vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue({
      ...successfulGit,
      stdout: outcome === "absent" ? "" : `${pinnedCommit}\trefs/heads/main\n`,
      ...(outcome === "uncertain" ? { cleanup: "uncertain" } : {}),
    });
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
