import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import * as processExec from "../process/exec.js";
import { cloneProjectCheckout, ProjectCloneError } from "./project-clone-runtime.js";

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
