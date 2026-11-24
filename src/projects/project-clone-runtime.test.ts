import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processExec from "../process/exec.js";
import { cloneProjectCheckout, ProjectCloneError } from "./project-clone-runtime.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

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

it.each(["timeout", "no-output-timeout"] as const)(
  "separates an absolute clone deadline from a stalled transfer (%s)",
  async (termination) => {
    const target = path.join(dirs.make("openclaw-clone-deadline-"), "checkout");
    const command = vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue({
      code: null,
      stdout: "",
      stderr: "",
      termination,
      signal: null,
      killed: true,
    });
    await expect(
      cloneProjectCheckout({ url: "https://github.com/example/project.git", target }),
    ).rejects.toMatchObject({
      failure: termination === "timeout" ? "clone_failed" : "network",
      message: expect.stringContaining(
        termination === "timeout" ? "did not finish within 30 minutes" : "could not reach GitHub",
      ),
    });
    expect(command).toHaveBeenCalledWith(
      expect.arrayContaining(["clone", "--progress"]),
      expect.objectContaining({ timeoutMs: 30 * 60_000, noOutputTimeoutMs: 2 * 60_000 }),
    );
  },
);
