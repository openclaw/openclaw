import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import type { UpdateStepProgress } from "../../infra/update-runner-types.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { writeFixtureJson } from "../cli-fixtures.test-support.js";
import {
  ensureGitCheckout,
  parseUpdateTimeoutMs,
  resolveUpdateRoot,
  runUpdateStep,
  tryWriteCompletionCache,
} from "./shared.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runCommandWithTimeout,
}));

const successfulCommandResult = createCommandResult();

function cloneTarget(argv: string[]): string {
  const target = argv.at(-1);
  if (!target) {
    throw new Error("git clone target missing from command");
  }
  return target;
}

function checkout(
  dir: string,
  options: Omit<Parameters<typeof ensureGitCheckout>[0], "dir" | "timeoutMs" | "env"> = {},
) {
  return ensureGitCheckout({ dir, timeoutMs: 1_000, env: process.env, ...options });
}

async function expectFile(directory: string, name = "checkout.marker", content = "complete\n") {
  await expect(fs.readFile(path.join(directory, name), "utf8")).resolves.toBe(content);
}

async function writeClone(stagingDir: string, git = false) {
  if (git) {
    await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
  }
  await fs.writeFile(path.join(stagingDir, "checkout.marker"), "complete\n");
}

function mockClone(prepare: (stagingDir: string) => Promise<void>) {
  runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
    await prepare(cloneTarget(argv));
    return successfulCommandResult;
  });
}

const mockCompleteClone = (git = false) => mockClone((dir) => writeClone(dir, git));

function expectCleanupAdvisory(
  report: ReturnType<typeof vi.fn<NonNullable<UpdateStepProgress["onStepComplete"]>>>,
  retained: string,
) {
  const steps = report.mock.calls
    .map(([step]) => step)
    .filter((step) => step.name === "git-clone-staging-cleanup");
  const advisory = expect.objectContaining({
    advisory: { kind: "recoverable-maintenance", message: expect.stringContaining(retained) },
  });
  expect(steps).toContainEqual(advisory);
  return steps;
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let base: string;
let checkoutDir: string;

beforeEach(() => {
  base = tempDirs.make("openclaw-update-shared-");
  checkoutDir = path.join(base, "openclaw");
  vi.clearAllMocks();
  runCommandWithTimeout.mockResolvedValue(successfulCommandResult);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("refreshes standalone completion without a loose launcher", async () => {
  const runtime = path.join(base, "runtime");
  const executable = path.join(base, "openclaw");
  await fs.mkdir(runtime);
  await writeFixtureJson(path.join(base, "manifest.json"), {
    schemaVersion: 1,
    mode: "jit",
    executable: { path: "openclaw" },
    runtime: { path: "runtime" },
    openclaw: { version: "2026.10.15" },
    bun: { version: "1.3.0" },
  });

  await expect(tryWriteCompletionCache(runtime, true, 500, executable)).resolves.toBe("completed");
  expect(runCommandWithTimeout).toHaveBeenCalledExactlyOnceWith(
    [executable, "completion", "--write-state"],
    expect.objectContaining({ cwd: runtime, timeoutMs: 500 }),
  );
});

it.each([false, true])("propagates uncertain completion cleanup: %s", async (uncertain) => {
  await fs.writeFile(path.join(base, "openclaw.mjs"), "");
  const error = uncertain ? new CommandProcessCleanupError() : new Error("cache write failed");
  runCommandWithTimeout.mockRejectedValueOnce(error);
  const result = tryWriteCompletionCache(base, true, 500);
  if (uncertain) {
    await expect(result).rejects.toBe(error);
  } else {
    await expect(result).resolves.toBe("failed");
  }
});

it("validates timeout seconds after trimming and preserves the absent default", () => {
  for (const timeout of ["1.5", "0", String(Number.MAX_SAFE_INTEGER)]) {
    expect(() => parseUpdateTimeoutMs(timeout)).toThrow(
      "--timeout must be a positive integer (seconds)",
    );
  }
  expect(parseUpdateTimeoutMs(" 10 ")).toBe(10_000);
  expect(parseUpdateTimeoutMs(undefined)).toBeUndefined();
});

it("closes install stdin without approval and retains failed command diagnostics", async () => {
  runCommandWithTimeout.mockResolvedValueOnce({
    ...successfulCommandResult,
    code: 1,
    stdout: `${"x".repeat(10_000)}\nBuild type error`,
    stderr: "Command failed",
  });
  const result = await runUpdateStep({
    name: "package-install",
    argv: ["pnpm", "add", "-g", "openclaw@2.0.0"],
    input: "",
  });

  expect(result.stdoutTail).toContain("Build type error");
  expect(result.stdoutTail?.length).toBeLessThanOrEqual(8001); // includes the truncation marker
  expect(result).toMatchObject({ stderrTail: "Command failed", exitCode: 1 });
  expect(runCommandWithTimeout.mock.calls[0]?.[1].input).toBe("");
});

it.runIf(process.platform !== "win32")(
  "resolves update ownership from the lexical invocation path",
  async () => {
    const storeRoot = path.join(base, "store", "openclaw");
    const packageRoot = path.join(base, "global", "v11", "install", "node_modules", "openclaw");
    await fs.mkdir(path.dirname(packageRoot), { recursive: true });
    await fs.mkdir(storeRoot, { recursive: true });
    await writeFixtureJson(path.join(storeRoot, "package.json"), { name: "openclaw" });
    await fs.symlink(storeRoot, packageRoot, "dir");

    const previousArgv = [...process.argv];
    process.argv[1] = path.join(packageRoot, "openclaw.mjs");
    try {
      await expect(resolveUpdateRoot()).resolves.toBe(packageRoot);
    } finally {
      process.argv.splice(0, process.argv.length, ...previousArgv);
    }
  },
);

it.each([false, true])("keeps clone build storage stationary (existing: %s)", async (existing) => {
  checkoutDir = path.join(base, "nested", "openclaw");
  if (existing) {
    await fs.mkdir(checkoutDir, { recursive: true });
  }
  mockClone(async (stagingDir) => {
    expect(stagingDir).not.toBe(checkoutDir);
    if (!existing) {
      await expect(fs.stat(checkoutDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await writeClone(stagingDir, true);
  });

  const result = await checkout(checkoutDir, {
    useStagedCheckout: async (stagingDir, publish, targetRoot, storageRoot) => {
      const artifacts = path.join(storageRoot, ".artifacts");
      await fs.mkdir(artifacts);
      await fs.writeFile(path.join(artifacts, "build.marker"), "built\n");
      expect(path.dirname(stagingDir)).toBe(storageRoot);
      expect(await publish()).toBe(targetRoot);
      expect((await fs.stat(artifacts)).dev).toBe((await fs.stat(targetRoot)).dev);
      await expectFile(artifacts, "build.marker", "built\n");
    },
  });
  expect(result).toMatchObject({ checkoutDir, step: { exitCode: 0 } });
  expect(result.step?.warnings).toBeUndefined();

  await expectFile(checkoutDir);
  await expect(fs.readdir(path.dirname(checkoutDir))).resolves.toEqual(["openclaw"]);
  expect((await fs.readdir(checkoutDir)).toSorted()).toEqual([".git", "checkout.marker"]);
});

it("preserves a destination created while a fresh clone is running", async () => {
  mockClone(async (stagingDir) => {
    await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
    await fs.mkdir(checkoutDir);
    await fs.writeFile(path.join(checkoutDir, "user.marker"), "keep\n");
  });

  await expect(checkout(checkoutDir)).rejects.toThrow("appeared while cloning");

  await expectFile(checkoutDir, "user.marker", "keep\n");
  await expect(fs.readdir(base)).resolves.toEqual(["openclaw"]);
});

it.each([false, true])("retries failed clones (existing: %s)", async (existing) => {
  if (existing) {
    await fs.mkdir(checkoutDir);
  }
  runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
    const stagingDir = cloneTarget(argv);
    expect(stagingDir).not.toBe(checkoutDir);
    await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
    return { ...successfulCommandResult, code: 42, stderr: "clone interrupted" };
  });
  await expect(checkout(checkoutDir)).resolves.toMatchObject({
    checkoutDir,
    step: { exitCode: 42 },
  });
  await expect(fs.readdir(existing ? checkoutDir : base)).resolves.toEqual([]);
  if (!existing) {
    await expect(fs.stat(checkoutDir)).rejects.toMatchObject({ code: "ENOENT" });
  }
  mockCompleteClone(true);
  await expect(checkout(checkoutDir)).resolves.toMatchObject({
    checkoutDir,
    step: { exitCode: 0 },
  });
  await expectFile(checkoutDir);
});

it.each([
  { existing: false, contents: "empty" },
  { existing: true, contents: "empty" },
  { existing: true, contents: "user" },
  { existing: true, contents: "replaced" },
])(
  "preserves allocation-failure storage ($contents, existing: $existing)",
  async ({ existing, contents }) => {
    if (existing) {
      await fs.mkdir(checkoutDir);
    }
    const allocationError = Object.assign(new Error("clone storage exhausted"), {
      code: "ENOSPC",
    });
    const mkdir = fs.mkdir.bind(fs);
    let retained = "";
    const allocation = vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
      if (path.basename(String(target)) !== "repository") {
        return mkdir(target, options);
      }
      retained = path.dirname(String(target));
      if (contents === "replaced") {
        await fs.rename(retained, path.join(base, "displaced"));
        await mkdir(retained);
      }
      if (contents !== "empty") {
        await fs.writeFile(path.join(retained, "user.marker"), "keep\n");
      }
      throw allocationError;
    });
    await expect(checkout(checkoutDir)).rejects.toBe(allocationError);
    allocation.mockRestore();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    if (contents === "empty") {
      await expect(fs.readdir(existing ? checkoutDir : base)).resolves.toEqual([]);
      if (!existing) {
        await expect(fs.stat(checkoutDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
      mockCompleteClone(true);
      await expect(checkout(checkoutDir)).resolves.toMatchObject({
        checkoutDir,
        step: { exitCode: 0 },
      });
      await expectFile(checkoutDir);
    } else {
      await expectFile(retained, "user.marker", "keep\n");
    }
  },
);

it.runIf(process.platform !== "win32").each([false, true])(
  "publishes to the original symlink target (retargeted: %s)",
  async (retargeted) => {
    const targetDir = path.join(base, "checkout-target");
    const replacementDir = path.join(base, "replacement-target");
    await fs.mkdir(targetDir);
    await fs.mkdir(replacementDir);
    await fs.symlink(targetDir, checkoutDir, "dir");
    mockClone(async (stagingDir) => {
      expect(path.dirname(path.dirname(stagingDir))).toBe(targetDir);
      await writeClone(stagingDir, true);
      if (retargeted) {
        await fs.unlink(checkoutDir);
        await fs.symlink(replacementDir, checkoutDir, "dir");
      }
    });

    await expect(checkout(checkoutDir)).resolves.toMatchObject({
      checkoutDir: targetDir,
      step: { exitCode: 0 },
    });

    expect((await fs.lstat(checkoutDir)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(targetDir)).isSymbolicLink()).toBe(false);
    await expectFile(targetDir);
    if (!retargeted) {
      await expectFile(checkoutDir);
    }

    await expect(fs.readdir(replacementDir)).resolves.toEqual([]);
  },
);

it.each(["destination", "storage", "repository"] as const)(
  "preserves replaced %s before publication",
  async (replaced) => {
    const displacedDir = path.join(base, "displaced");
    await fs.mkdir(checkoutDir);
    mockCompleteClone();
    let replacementStage = "";
    await expect(
      checkout(checkoutDir, {
        useStagedCheckout: async (stagingDir, publish, _targetRoot, storageRoot) => {
          const movedDir =
            replaced === "destination"
              ? checkoutDir
              : replaced === "storage"
                ? storageRoot
                : stagingDir;
          await fs.rename(movedDir, displacedDir);
          await fs.mkdir(movedDir);
          replacementStage = movedDir;
          if (replaced === "destination") {
            await fs.rename(path.join(displacedDir, path.basename(storageRoot)), storageRoot);
          }
          const userDir = replaced === "destination" ? displacedDir : movedDir;
          await fs.writeFile(path.join(userDir, "user.marker"), "keep\n");
          await publish();
        },
      }),
    ).rejects.toThrow("changed before publication");
    const userDir = replaced === "destination" ? displacedDir : replacementStage;
    await expectFile(userDir, "user.marker", "keep\n");
    if (replaced === "destination") {
      await expect(fs.readdir(checkoutDir)).resolves.toEqual([]);
    } else {
      await expect(fs.readdir(replacementStage)).resolves.toEqual(["user.marker"]);
      await expectFile(
        replaced === "storage" ? path.join(displacedDir, "repository") : displacedDir,
      );
    }
  },
);

it.each([
  { published: false, missingStorage: false },
  { published: true, missingStorage: false },
  { published: true, missingStorage: true },
])(
  "reports custody loss (published: $published, missing: $missingStorage)",
  async ({ published, missingStorage }) => {
    const onStepComplete = vi.fn<NonNullable<UpdateStepProgress["onStepComplete"]>>((step) => {
      if (step.name === "git-clone-staging-cleanup") {
        throw new Error("cleanup warning ledger unavailable");
      }
    });
    let retained = "";
    let publicationError: unknown;
    mockCompleteClone();
    const result = checkout(checkoutDir, {
      progress: { onStepComplete },
      useStagedCheckout: async (stagingDir, publish, _targetRoot, storageRoot) => {
        retained = storageRoot;
        await fs.writeFile(path.join(storageRoot, "build.marker"), "keep\n");
        if (published) {
          await publish();
          if (missingStorage) {
            await fs.rm(storageRoot, { recursive: true });
          } else {
            await fs.mkdir(stagingDir);
            await fs.writeFile(path.join(stagingDir, "user.marker"), "keep\n");
          }
        } else {
          await fs.rename(stagingDir, path.join(base, "displaced"));
          try {
            await publish();
          } catch (error) {
            publicationError = error;
            throw error;
          }
        }
      },
    });
    if (published) {
      await expect(result).resolves.toMatchObject({
        checkoutDir,
        step: {
          exitCode: 0,
          warnings: [expect.stringContaining("ownership could not be verified")],
        },
      });
      await expectFile(checkoutDir);
      if (!missingStorage) {
        await expectFile(path.join(retained, "repository"), "user.marker", "keep\n");
      }
    } else {
      await expect(result).rejects.toThrow("changed before publication");
      await expect(result).rejects.toBe(publicationError);
    }
    if (missingStorage) {
      await expect(fs.stat(retained)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expectFile(retained, "build.marker", "keep\n");
    }
    const cleanupSteps = expectCleanupAdvisory(onStepComplete, retained);
    expect(cleanupSteps).toHaveLength(1);
    const cleanupStep = cleanupSteps[0]!;
    expect(cleanupStep.command).toBe("");
    expect(cleanupStep.advisory?.message).not.toMatch(/retained|rm -rf|Remove-Item/u);
  },
);

it.each([
  { callbackFails: false, cleanupFailure: "remove", reportingUnknown: false },
  { callbackFails: true, cleanupFailure: "remove", reportingUnknown: false },
  { callbackFails: false, cleanupFailure: "inspect", reportingUnknown: false },
  { callbackFails: true, cleanupFailure: "inspect", reportingUnknown: false },
  { callbackFails: false, cleanupFailure: "remove", reportingUnknown: true },
  { callbackFails: true, cleanupFailure: "remove", reportingUnknown: true },
])(
  "preserves $cleanupFailure cleanup (callback: $callbackFails, uncertain: $reportingUnknown)",
  async ({ callbackFails, cleanupFailure, reportingUnknown }) => {
    const callbackError = new Error("candidate operation failed");
    const reportingError = reportingUnknown
      ? new CommandProcessCleanupError()
      : new Error("cleanup warning ledger unavailable");
    const onStepComplete = vi.fn(async (step: { name: string }) => {
      if (step.name === "git-clone-staging-cleanup") {
        throw reportingError;
      }
    });
    let retained = "";
    let published = false;
    mockCompleteClone();
    const remove = fs.rm.bind(fs);
    using cleanup = vi.spyOn(fs, "rm").mockImplementation((target, options) => {
      if (cleanupFailure === "remove" && String(target) === retained) {
        return Promise.reject(Object.assign(new Error("cleanup denied"), { code: "EPERM" }));
      }
      return remove(target, options);
    });
    const lstat = fs.lstat.bind(fs);
    using _ = vi.spyOn(fs, "lstat").mockImplementation((...args) => {
      if (
        cleanupFailure === "inspect" &&
        published &&
        String(args[0]) === path.join(retained, "repository")
      ) {
        return Promise.reject(Object.assign(new Error("cleanup denied"), { code: "EACCES" }));
      }
      return lstat(...args);
    });

    const update = checkout(checkoutDir, {
      progress: { onStepComplete },
      useStagedCheckout: async (_stagingDir, publish, _targetRoot, storageRoot) => {
        retained = storageRoot;
        await fs.writeFile(path.join(storageRoot, "build.marker"), "keep\n");
        await publish();
        published = true;
        if (callbackFails) {
          throw callbackError;
        }
      },
    });
    if (reportingUnknown) {
      const error = await update.catch((cause: unknown) => cause);
      expect(hasCommandProcessCleanupError(error)).toBe(true);
      expect(collectNestedErrorCandidates(error)).toContain(reportingError);
      if (callbackFails) {
        expect(collectNestedErrorCandidates(error)).toContain(callbackError);
        expect(error).toMatchObject({ cause: callbackError });
      } else {
        expect(error).toBe(reportingError);
      }
    } else if (callbackFails) {
      await expect(update).rejects.toBe(callbackError);
    } else {
      await expect(update).resolves.toMatchObject({
        checkoutDir,
        step: { exitCode: 0, warnings: [expect.stringContaining("cleanup denied")] },
      });
    }
    await expectFile(checkoutDir);
    await expectFile(retained, "build.marker", "keep\n");
    if (cleanupFailure === "inspect") {
      expect(cleanup).not.toHaveBeenCalledWith(retained, expect.anything());
      expect(onStepComplete).toHaveBeenCalledWith(
        expect.objectContaining({ command: "", stderrTail: "cleanup denied" }),
      );
    }
    expectCleanupAdvisory(onStepComplete, retained);
  },
);

it("retains an unpublished clone when its staged callback reports uncertain cleanup", async () => {
  const failure = new CommandProcessCleanupError();
  let stagedFile = "";
  mockClone(async (stagingDir) => {
    stagedFile = path.join(stagingDir, "checkout.marker");
    await fs.writeFile(stagedFile, "retain candidate bytes\n");
  });
  await expect(
    checkout(checkoutDir, {
      useStagedCheckout: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  await expect(fs.readFile(stagedFile, "utf8")).resolves.toBe("retain candidate bytes\n");
  await expect(fs.access(checkoutDir)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains recovery files when publication and rollback both fail", async () => {
  await fs.mkdir(checkoutDir);
  mockCompleteClone(true);

  const realRename = fs.rename.bind(fs);
  using _ = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
    const oldName = path.basename(oldPath.toString());
    const oldParent = path.dirname(oldPath.toString());
    const newParent = path.dirname(newPath.toString());
    if (oldName === ".git" && newParent === checkoutDir) {
      throw new Error("injected publication failure");
    }
    if (oldName === "checkout.marker" && oldParent === checkoutDir) {
      throw new Error("injected rollback failure");
    }
    await realRename(oldPath, newPath);
  });

  await expect(checkout(checkoutDir)).rejects.toThrow("recovery files remain");

  await expectFile(checkoutDir);
  const recoveryDirs = (await fs.readdir(checkoutDir)).filter((entry) =>
    entry.startsWith(".openclaw-clone-"),
  );
  expect(recoveryDirs).toHaveLength(1);
  await expect(
    fs.stat(path.join(checkoutDir, recoveryDirs[0]!, "repository", ".git")),
  ).resolves.toBeDefined();
});
