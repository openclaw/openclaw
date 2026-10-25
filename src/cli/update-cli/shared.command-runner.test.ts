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
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import {
  ensureGitCheckout,
  parseUpdateTimeoutMs,
  resolveGlobalManager,
  resolveUpdateRoot,
  runUpdateStep,
  tryWriteCompletionCache,
  UpdatePreMutationError,
} from "./shared.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());
const runCommandBuffered = vi.hoisted(() =>
  vi.fn(async () => ({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: null,
    signal: null,
    killed: false,
    termination: "error" as const,
    error: Object.assign(new Error("fixture package database unavailable"), { code: "EACCES" }),
  })),
);

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runCommandWithTimeout,
  runCommandBuffered,
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

async function expectFile(directory: string, name: string, content: string) {
  await expect(fs.readFile(path.join(directory, name), "utf8")).resolves.toBe(content);
}

async function writeClone(stagingDir: string, git = false) {
  if (git) {
    await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
  }
  await fs.writeFile(path.join(stagingDir, "checkout.marker"), "complete\n");
}

function mockCompleteClone(git = false) {
  runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
    await writeClone(cloneTarget(argv), git);
    return successfulCommandResult;
  });
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
  await fs.writeFile(
    path.join(base, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      mode: "jit",
      executable: { path: "openclaw" },
      runtime: { path: "runtime" },
      openclaw: { version: "2026.10.15" },
      bun: { version: "1.3.0" },
    }),
  );

  await expect(tryWriteCompletionCache(runtime, true, 500, executable)).resolves.toBe("completed");
  expect(runCommandWithTimeout).toHaveBeenCalledExactlyOnceWith(
    [executable, "completion", "--write-state"],
    expect.objectContaining({ cwd: runtime, timeoutMs: 500 }),
  );
});

it.each([false, true])(
  "does not hide uncertain completion cleanup (uncertain=%s)",
  async (uncertain) => {
    await fs.writeFile(path.join(base, "openclaw.mjs"), "");
    const error = uncertain ? new CommandProcessCleanupError() : new Error("cache write failed");
    runCommandWithTimeout.mockRejectedValueOnce(error);
    const result = tryWriteCompletionCache(base, true, 500);
    if (uncertain) {
      await expect(result).rejects.toBe(error);
    } else {
      await expect(result).resolves.toBe("failed");
    }
  },
);

it("accepts only complete positive integer timeout seconds", () => {
  for (const timeout of [
    "",
    "1.5",
    "10abc",
    "0x10",
    "0",
    "-1",
    "   ",
    String(Number.MAX_SAFE_INTEGER),
  ]) {
    expect(() => parseUpdateTimeoutMs(timeout)).toThrow(
      "--timeout must be a positive integer (seconds)",
    );
  }
  for (const [input, milliseconds] of [
    [" 10 ", 10_000],
    ["+10", 10_000],
    ["001", 1_000],
    [undefined, undefined],
  ] as const) {
    expect(parseUpdateTimeoutMs(input)).toBe(milliseconds);
  }
});

it("closes install stdin without approval and retains failed command diagnostics", async () => {
  runCommandWithTimeout.mockResolvedValueOnce({
    ...successfulCommandResult,
    code: 1,
    stdout: `${"x".repeat(10_000)}\nBuild type error`,
    stderr: "Command failed",
  });
  const onStepComplete = vi.fn();
  const result = await runUpdateStep({
    name: "package-install",
    argv: ["pnpm", "add", "-g", "openclaw@2.0.0"],
    timeoutMs: 1200,
    input: "",
    progress: { onStepComplete },
  });

  expect(result.stdoutTail).toContain("Build type error");
  expect(result.stdoutTail?.length).toBeLessThanOrEqual(8001); // includes the truncation marker
  expect(onStepComplete).toHaveBeenCalledWith(
    expect.objectContaining({
      stdoutTail: result.stdoutTail,
      stderrTail: "Command failed",
      exitCode: 1,
    }),
  );
  expect(runCommandWithTimeout).toHaveBeenCalledWith(
    ["pnpm", "add", "-g", "openclaw@2.0.0"],
    expect.objectContaining({ input: "" }),
  );
});

it.runIf(process.platform !== "win32")(
  "resolves update ownership from the lexical invocation path",
  async () => {
    const storeRoot = path.join(base, "store", "openclaw");
    const packageRoot = path.join(base, "global", "v11", "install", "node_modules", "openclaw");
    await fs.mkdir(path.dirname(packageRoot), { recursive: true });
    await fs.mkdir(storeRoot, { recursive: true });
    await fs.writeFile(
      path.join(storeRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.0.0" }),
      "utf8",
    );
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

it.each(["/shared", "/opt/homebrew-custom"])(
  "refuses unowned packages under %s without treating global npm as a Homebrew formula",
  async (prefix) => {
    const root = `${prefix}/lib/node_modules/openclaw`;
    vi.stubEnv("HOMEBREW_PREFIX", "/opt/homebrew-custom");
    runCommandWithTimeout.mockResolvedValue({
      ...successfulCommandResult,
      code: 1,
      stderr: "not owned",
    });
    const owner = withMockedPlatform("linux", () =>
      resolveGlobalManager({ root, installKind: "package", timeoutMs: 1_000 }),
    );
    await expect(owner).rejects.toBeInstanceOf(UpdatePreMutationError);
    await expect(owner).rejects.toMatchObject({
      reason: expect.stringMatching(/^(unmanaged-package-install|container-image-install)$/),
      failureFacts: [expect.objectContaining({ code: "installation-unclassified" })],
      message: expect.stringContaining("No package changes or Gateway restart were attempted."),
    });
    await expect(owner).rejects.not.toMatchObject({
      message: expect.stringContaining("managed by Homebrew"),
    });
  },
);

it.each([false, true])(
  "keeps build storage stationary while publishing a clone (existing destination: %s)",
  async (existing) => {
    checkoutDir = path.join(base, "nested", "openclaw");
    if (existing) {
      await fs.mkdir(checkoutDir, { recursive: true });
    }
    runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
      const stagingDir = cloneTarget(argv);
      expect(stagingDir).not.toBe(checkoutDir);
      if (!existing) {
        await expect(fs.stat(checkoutDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await writeClone(stagingDir, true);
      return successfulCommandResult;
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

    await expectFile(checkoutDir, "checkout.marker", "complete\n");
    await expect(fs.readdir(path.dirname(checkoutDir))).resolves.toEqual(["openclaw"]);
    expect((await fs.readdir(checkoutDir)).toSorted()).toEqual([".git", "checkout.marker"]);
  },
);

it("preserves a destination created while a fresh clone is running", async () => {
  runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
    const stagingDir = cloneTarget(argv);
    await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
    await fs.mkdir(checkoutDir);
    await fs.writeFile(path.join(checkoutDir, "user.marker"), "keep\n");
    return successfulCommandResult;
  });

  await expect(checkout(checkoutDir)).rejects.toThrow("appeared while cloning");

  await expectFile(checkoutDir, "user.marker", "keep\n");
  await expect(fs.readdir(base)).resolves.toEqual(["openclaw"]);
});

it.each([
  { existing: false, failure: "allocation" },
  { existing: true, failure: "allocation" },
  { existing: false, failure: "clone" },
  { existing: true, failure: "clone" },
])(
  "keeps clone destinations retryable after $failure failure (existing: $existing)",
  async ({ existing, failure }) => {
    if (existing) {
      await fs.mkdir(checkoutDir);
    }
    let attempt = 0;
    runCommandWithTimeout.mockImplementation(async (argv: string[]) => {
      attempt += 1;
      const stagingDir = cloneTarget(argv);
      expect(stagingDir).not.toBe(checkoutDir);
      await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
      if (failure === "clone" && attempt === 1) {
        return { ...successfulCommandResult, code: 42, stderr: "clone interrupted" };
      }
      await fs.writeFile(path.join(stagingDir, "checkout.marker"), "complete\n");
      return successfulCommandResult;
    });
    const allocationError = Object.assign(new Error("clone storage exhausted"), {
      code: "ENOSPC",
    });
    const mkdir = fs.mkdir.bind(fs);
    const allocation = vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
      if (failure === "allocation" && path.basename(String(target)) === "repository") {
        throw allocationError;
      }
      return mkdir(target, options);
    });
    const first = checkout(checkoutDir);
    if (failure === "allocation") {
      await expect(first).rejects.toBe(allocationError);
      expect(runCommandWithTimeout).not.toHaveBeenCalled();
    } else {
      await expect(first).resolves.toMatchObject({ checkoutDir, step: { exitCode: 42 } });
    }
    allocation.mockRestore();
    await expect(fs.readdir(existing ? checkoutDir : base)).resolves.toEqual([]);
    if (!existing) {
      await expect(fs.stat(checkoutDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(checkout(checkoutDir)).resolves.toMatchObject({
      checkoutDir,
      step: { exitCode: 0 },
    });
    await expectFile(checkoutDir, "checkout.marker", "complete\n");
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(failure === "allocation" ? 1 : 2);
  },
);

it.each([false, true])(
  "preserves storage contents after repository allocation fails (replaced: %s)",
  async (replaced) => {
    await fs.mkdir(checkoutDir);
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
      if (replaced) {
        await fs.rename(retained, path.join(base, "displaced"));
        await mkdir(retained);
      }
      await fs.writeFile(path.join(retained, "user.marker"), "keep\n");
      throw allocationError;
    });
    await expect(checkout(checkoutDir)).rejects.toBe(allocationError);
    allocation.mockRestore();
    await expectFile(retained, "user.marker", "keep\n");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  },
);

it.runIf(process.platform !== "win32").each([false, true])(
  "publishes through the original empty-directory alias target (retargeted: %s)",
  async (retargeted) => {
    const targetDir = path.join(base, "checkout-target");
    const replacementDir = path.join(base, "replacement-target");
    await fs.mkdir(targetDir);
    await fs.mkdir(replacementDir);
    await fs.symlink(targetDir, checkoutDir, "dir");
    runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
      const stagingDir = cloneTarget(argv);
      expect(path.dirname(path.dirname(stagingDir))).toBe(targetDir);
      await writeClone(stagingDir, true);
      if (retargeted) {
        await fs.unlink(checkoutDir);
        await fs.symlink(replacementDir, checkoutDir, "dir");
      }
      return successfulCommandResult;
    });

    await expect(checkout(checkoutDir)).resolves.toMatchObject({
      checkoutDir: targetDir,
      step: { exitCode: 0 },
    });

    expect((await fs.lstat(checkoutDir)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(targetDir)).isSymbolicLink()).toBe(false);
    await expectFile(targetDir, "checkout.marker", "complete\n");
    if (!retargeted) {
      await expectFile(checkoutDir, "checkout.marker", "complete\n");
    }

    await expect(fs.readdir(replacementDir)).resolves.toEqual([]);
  },
);

it.each(["destination", "storage", "repository"] as const)(
  "preserves a replaced %s directory before publication and cleanup",
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
        "checkout.marker",
        "complete\n",
      );
    }
  },
);

it.each([
  { published: false, missingStorage: false },
  { published: true, missingStorage: false },
  { published: true, missingStorage: true },
])(
  "reports skipped clone cleanup after custody loss (published: $published, missing storage: $missingStorage)",
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
      await expectFile(checkoutDir, "checkout.marker", "complete\n");
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
    const cleanupSteps = onStepComplete.mock.calls.filter(
      ([step]) => step.name === "git-clone-staging-cleanup",
    );
    expect(cleanupSteps).toHaveLength(1);
    expect(cleanupSteps[0]?.[0]).toMatchObject({
      command: "",
      advisory: {
        kind: "recoverable-maintenance",
        message: expect.stringContaining(retained),
      },
    });
    expect(cleanupSteps[0]?.[0].advisory?.message).not.toMatch(/retained|rm -rf|Remove-Item/u);
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
  "preserves clone cleanup outcomes ($cleanupFailure, callback fails: $callbackFails, reporting unknown: $reportingUnknown)",
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
    const cleanup = vi.spyOn(fs, "rm").mockImplementation((target, options) => {
      if (cleanupFailure === "remove" && String(target) === retained) {
        return Promise.reject(Object.assign(new Error("cleanup denied"), { code: "EPERM" }));
      }
      return remove(target, options);
    });
    const lstat = fs.lstat.bind(fs);
    const inspect = vi.spyOn(fs, "lstat").mockImplementation((...args) => {
      if (
        cleanupFailure === "inspect" &&
        published &&
        String(args[0]) === path.join(retained, "repository")
      ) {
        return Promise.reject(Object.assign(new Error("cleanup denied"), { code: "EACCES" }));
      }
      return lstat(...args);
    });
    try {
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
      await expectFile(checkoutDir, "checkout.marker", "complete\n");
      await expectFile(retained, "build.marker", "keep\n");
      if (cleanupFailure === "inspect") {
        expect(cleanup).not.toHaveBeenCalledWith(retained, expect.anything());
        expect(onStepComplete).toHaveBeenCalledWith(
          expect.objectContaining({ command: "", stderrTail: "cleanup denied" }),
        );
      }
      expect(onStepComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "git-clone-staging-cleanup",
          advisory: {
            kind: "recoverable-maintenance",
            message: expect.stringContaining(retained),
          },
        }),
      );
    } finally {
      inspect.mockRestore();
      cleanup.mockRestore();
    }
  },
);

it("retains an unpublished clone when its staged callback reports uncertain cleanup", async () => {
  const failure = new CommandProcessCleanupError();
  let stagedFile = "";
  runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
    stagedFile = path.join(cloneTarget(argv), "checkout.marker");
    await fs.writeFile(stagedFile, "retain candidate bytes\n");
    return successfulCommandResult;
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
  const rename = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
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

  try {
    await expect(checkout(checkoutDir)).rejects.toThrow("recovery files remain");
  } finally {
    rename.mockRestore();
  }

  await expectFile(checkoutDir, "checkout.marker", "complete\n");
  const recoveryDirs = (await fs.readdir(checkoutDir)).filter((entry) =>
    entry.startsWith(".openclaw-clone-"),
  );
  expect(recoveryDirs).toHaveLength(1);
  await expect(
    fs.stat(path.join(checkoutDir, recoveryDirs[0]!, "repository", ".git")),
  ).resolves.toBeDefined();
});
