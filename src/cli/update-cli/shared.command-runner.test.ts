// Shared command runner tests cover update helper command execution and error capture.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStepProgress } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  ensureGitCheckout,
  parseTimeoutMsOrExit,
  resolveGlobalManager,
  resolveUpdateRoot,
  runUpdateStep,
  UpdatePreMutationError,
} from "./shared.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout,
}));

const successfulCommandResult = {
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit" as const,
};

function cloneTarget(argv: string[]): string {
  const target = argv.at(-1);
  if (!target) {
    throw new Error("git clone target missing from command");
  }
  return target;
}

describe("update CLI shared helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCommandWithTimeout.mockResolvedValue(successfulCommandResult);
  });

  it("requires timeout values to be complete positive integer seconds", () => {
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);

    try {
      expect(parseTimeoutMsOrExit("")).toBeNull();
      expect(parseTimeoutMsOrExit("1.5")).toBeNull();
      expect(parseTimeoutMsOrExit("10abc")).toBeNull();
      expect(parseTimeoutMsOrExit("0x10")).toBeNull();
      expect(parseTimeoutMsOrExit("0")).toBeNull();
      expect(parseTimeoutMsOrExit("-1")).toBeNull();
      expect(parseTimeoutMsOrExit("   ")).toBeNull();
      expect(parseTimeoutMsOrExit(String(Number.MAX_SAFE_INTEGER))).toBeNull();

      expect(error).toHaveBeenCalledTimes(8);
      expect(error).toHaveBeenCalledWith("--timeout must be a positive integer (seconds)");
      expect(exit).toHaveBeenCalledTimes(8);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it("keeps failed command diagnostics in both progress and the final result", async () => {
    runCommandWithTimeout.mockResolvedValueOnce({
      ...successfulCommandResult,
      code: 1,
      stdout: `${"x".repeat(10_000)}\nBuild type error`,
      stderr: "Command failed",
    });
    const onStepComplete = vi.fn();
    const result = await runUpdateStep({
      name: "build",
      argv: ["pnpm", "build"],
      timeoutMs: 1200,
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
  });

  it("parses complete positive integer timeout values as milliseconds", () => {
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);

    try {
      expect(parseTimeoutMsOrExit(" 10 ")).toBe(10_000);
      expect(parseTimeoutMsOrExit("+10")).toBe(10_000);
      expect(parseTimeoutMsOrExit("001")).toBe(1_000);
      expect(parseTimeoutMsOrExit()).toBeUndefined();
      expect(error).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "resolves update ownership from the lexical invocation path",
    async () => {
      await withTestDir({ prefix: "openclaw-update-root-" }, async (base) => {
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
      });
    },
  );

  it("refuses a package root without a proven manager owner", async () => {
    runCommandWithTimeout.mockResolvedValue({
      ...successfulCommandResult,
      code: 1,
      stderr: "not owned",
    });

    const owner = resolveGlobalManager({
      root: "/shared/lib/node_modules/openclaw",
      installKind: "package",
      timeoutMs: 1_000,
    });
    await expect(owner).rejects.toBeInstanceOf(UpdatePreMutationError);
    await expect(owner).rejects.toMatchObject({
      name: "UpdatePreMutationError",
      reason: expect.stringMatching(/^(unmanaged-package-install|container-image-install)$/),
      failureFacts: [
        {
          check: "installation-inspection",
          code: "installation-unclassified",
          message: expect.stringMatching(/Installation ownership[\s\S]*retry openclaw update/),
        },
      ],
    });
    for (const detail of [
      "Root: /shared/lib/node_modules/openclaw",
      "Git metadata: absent or unreadable",
      "node_modules layout: package under node_modules",
      "local node_modules absent or unreadable",
      "package.json name: missing or unreadable",
      "Service unit target: not inspected",
      "Inspected package-manager owners:",
      "npm root -g",
      "pnpm root -g",
      "prefix -g",
      "No package changes or Gateway restart were attempted.",
    ]) {
      await expect(owner).rejects.toMatchObject({ message: expect.stringContaining(detail) });
    }
  });

  it.skipIf(process.platform === "win32")(
    "guides Homebrew-managed installations to use brew upgrade",
    async () => {
      await expect(
        resolveGlobalManager({
          root: "/opt/homebrew/Cellar/openclaw-cli/2026.9.2/libexec/lib/node_modules/openclaw",
          installKind: "package",
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({
        name: "UpdatePreMutationError",
        reason: "unmanaged-package-install",
        message:
          "This OpenClaw installation is managed by Homebrew. To update OpenClaw, run:\n\n  brew upgrade openclaw-cli\n\nThen restart the gateway:\n\n  openclaw gateway restart",
      });
    },
  );

  it("does not treat global npm packages under HOMEBREW_PREFIX as Homebrew formula installs", async () => {
    const originalPrefix = process.env.HOMEBREW_PREFIX;
    process.env.HOMEBREW_PREFIX = "/opt/homebrew-custom";
    runCommandWithTimeout.mockResolvedValue({
      ...successfulCommandResult,
      code: 1,
      stderr: "not owned",
    });

    try {
      const owner = resolveGlobalManager({
        root: "/opt/homebrew-custom/lib/node_modules/openclaw",
        installKind: "package",
        timeoutMs: 1_000,
      });
      await expect(owner).rejects.toBeInstanceOf(UpdatePreMutationError);
      await expect(owner).rejects.toMatchObject({
        name: "UpdatePreMutationError",
        message: expect.stringContaining("Root: /opt/homebrew-custom/lib/node_modules/openclaw"),
        failureFacts: [
          expect.objectContaining({
            check: "installation-inspection",
            code: "installation-unclassified",
          }),
        ],
      });
      await expect(owner).rejects.toMatchObject({
        message: expect.stringContaining("No package changes or Gateway restart were attempted."),
      });
      await expect(owner).rejects.not.toMatchObject({
        message: expect.stringContaining("managed by Homebrew"),
      });
    } finally {
      process.env.HOMEBREW_PREFIX = originalPrefix;
    }
  });

  it.each([false, true])(
    "keeps build storage stationary while publishing a clone (existing destination: %s)",
    async (existing) => {
      await withTestDir({ prefix: "openclaw-update-clone-success-" }, async (base) => {
        const checkoutDir = path.join(base, "nested", "openclaw");
        if (existing) {
          await fs.mkdir(checkoutDir, { recursive: true });
        }
        runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
          const stagingDir = cloneTarget(argv);
          expect(stagingDir).toMatch(/[/\\]\.openclaw-clone-[^/\\]+[/\\]repository$/u);
          expect(stagingDir).not.toBe(checkoutDir);
          if (!existing) {
            await expect(fs.stat(checkoutDir)).rejects.toMatchObject({ code: "ENOENT" });
          }
          await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
          await fs.writeFile(path.join(stagingDir, "checkout.marker"), "complete\n");
          return successfulCommandResult;
        });

        const result = await ensureGitCheckout({
          dir: checkoutDir,
          timeoutMs: 1_000,
          env: process.env,
          useStagedCheckout: async (stagingDir, publish, targetRoot, storageRoot) => {
            const artifacts = path.join(storageRoot, ".artifacts");
            await fs.mkdir(artifacts);
            await fs.writeFile(path.join(artifacts, "build.marker"), "built\n");
            expect(path.dirname(stagingDir)).toBe(storageRoot);
            expect(await publish()).toBe(targetRoot);
            expect((await fs.stat(artifacts)).dev).toBe((await fs.stat(targetRoot)).dev);
            expect(await fs.readFile(path.join(artifacts, "build.marker"), "utf8")).toBe("built\n");
          },
        });
        expect(result).toMatchObject({ checkoutDir, step: { exitCode: 0 } });
        expect(result.step?.warnings).toBeUndefined();

        await expect(fs.readFile(path.join(checkoutDir, "checkout.marker"), "utf8")).resolves.toBe(
          "complete\n",
        );
        await expect(fs.readdir(path.dirname(checkoutDir))).resolves.toEqual(["openclaw"]);
        await expect(fs.readdir(checkoutDir)).resolves.toEqual([".git", "checkout.marker"]);
        expect(runCommandWithTimeout).toHaveBeenCalledWith(
          [
            "git",
            "clone",
            "--filter=blob:none",
            "https://github.com/openclaw/openclaw.git",
            expect.stringMatching(/[/\\]\.openclaw-clone-[^/\\]+[/\\]repository$/u),
          ],
          expect.objectContaining({ env: process.env, timeoutMs: 1_000 }),
        );
      });
    },
  );

  it("removes a failed fresh clone without publishing the destination", async () => {
    await withTestDir({ prefix: "openclaw-update-clone-failure-" }, async (base) => {
      const checkoutDir = path.join(base, "openclaw");
      runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
        const stagingDir = cloneTarget(argv);
        await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
        return {
          ...successfulCommandResult,
          stderr: "clone interrupted",
          code: 42,
        };
      });

      await expect(
        ensureGitCheckout({ dir: checkoutDir, timeoutMs: 1_000, env: process.env }),
      ).resolves.toMatchObject({ checkoutDir, step: { exitCode: 42 } });

      await expect(fs.stat(checkoutDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(base)).resolves.toEqual([]);
    });
  });

  it("preserves a destination created while a fresh clone is running", async () => {
    await withTestDir({ prefix: "openclaw-update-clone-race-" }, async (base) => {
      const checkoutDir = path.join(base, "openclaw");
      runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
        const stagingDir = cloneTarget(argv);
        await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
        await fs.mkdir(checkoutDir);
        await fs.writeFile(path.join(checkoutDir, "user.marker"), "keep\n");
        return successfulCommandResult;
      });

      await expect(
        ensureGitCheckout({ dir: checkoutDir, timeoutMs: 1_000, env: process.env }),
      ).rejects.toThrow("appeared while cloning");

      await expect(fs.readFile(path.join(checkoutDir, "user.marker"), "utf8")).resolves.toBe(
        "keep\n",
      );
      await expect(fs.readdir(base)).resolves.toEqual(["openclaw"]);
    });
  });

  it.each([
    { existing: false, failure: "allocation" },
    { existing: true, failure: "allocation" },
    { existing: true, failure: "clone" },
  ])(
    "keeps clone destinations retryable after $failure failure (existing: $existing)",
    async ({ existing, failure }) => {
      await withTestDir({ prefix: "openclaw-update-clone-existing-" }, async (base) => {
        const checkoutDir = path.join(base, "openclaw");
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
        try {
          const first = ensureGitCheckout({ dir: checkoutDir, timeoutMs: 1_000, env: process.env });
          if (failure === "allocation") {
            await expect(first).rejects.toBe(allocationError);
            expect(runCommandWithTimeout).not.toHaveBeenCalled();
          } else {
            await expect(first).resolves.toMatchObject({ checkoutDir, step: { exitCode: 42 } });
          }
        } finally {
          allocation.mockRestore();
        }
        await expect(fs.readdir(existing ? checkoutDir : base)).resolves.toEqual([]);
        await expect(
          ensureGitCheckout({ dir: checkoutDir, timeoutMs: 1_000, env: process.env }),
        ).resolves.toMatchObject({ checkoutDir, step: { exitCode: 0 } });
        await expect(fs.readFile(path.join(checkoutDir, "checkout.marker"), "utf8")).resolves.toBe(
          "complete\n",
        );
        expect(runCommandWithTimeout).toHaveBeenCalledTimes(failure === "allocation" ? 1 : 2);
      });
    },
  );

  it.each([false, true])(
    "preserves storage contents after repository allocation fails (replaced: %s)",
    async (replaced) => {
      await withTestDir({ prefix: "openclaw-update-clone-allocation-" }, async (base) => {
        const checkoutDir = path.join(base, "openclaw");
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
        try {
          await expect(
            ensureGitCheckout({ dir: checkoutDir, timeoutMs: 1_000, env: process.env }),
          ).rejects.toBe(allocationError);
        } finally {
          allocation.mockRestore();
        }
        expect(await fs.readFile(path.join(retained, "user.marker"), "utf8")).toBe("keep\n");
        expect(runCommandWithTimeout).not.toHaveBeenCalled();
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves a stable alias to an existing empty checkout destination",
    async () => {
      await withTestDir({ prefix: "openclaw-update-clone-alias-" }, async (base) => {
        const targetDir = path.join(base, "checkout-target");
        const checkoutDir = path.join(base, "openclaw");
        await fs.mkdir(targetDir);
        await fs.symlink(targetDir, checkoutDir, "dir");
        runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
          const stagingDir = cloneTarget(argv);
          expect(path.dirname(path.dirname(stagingDir))).toBe(targetDir);
          await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
          await fs.writeFile(path.join(stagingDir, "checkout.marker"), "complete\n");
          return successfulCommandResult;
        });

        await expect(
          ensureGitCheckout({ dir: checkoutDir, timeoutMs: 1_000, env: process.env }),
        ).resolves.toMatchObject({ checkoutDir: targetDir, step: { exitCode: 0 } });

        expect((await fs.lstat(checkoutDir)).isSymbolicLink()).toBe(true);
        expect((await fs.lstat(targetDir)).isSymbolicLink()).toBe(false);
        await expect(fs.readFile(path.join(checkoutDir, "checkout.marker"), "utf8")).resolves.toBe(
          "complete\n",
        );
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "publishes through the original target when an empty-directory alias is retargeted",
    async () => {
      await withTestDir({ prefix: "openclaw-update-clone-alias-race-" }, async (base) => {
        const targetDir = path.join(base, "checkout-target");
        const replacementDir = path.join(base, "replacement-target");
        const checkoutDir = path.join(base, "openclaw");
        await fs.mkdir(targetDir);
        await fs.mkdir(replacementDir);
        await fs.symlink(targetDir, checkoutDir, "dir");
        runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
          const stagingDir = cloneTarget(argv);
          expect(path.dirname(path.dirname(stagingDir))).toBe(targetDir);
          await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
          await fs.writeFile(path.join(stagingDir, "checkout.marker"), "complete\n");
          await fs.unlink(checkoutDir);
          await fs.symlink(replacementDir, checkoutDir, "dir");
          return successfulCommandResult;
        });

        await expect(
          ensureGitCheckout({ dir: checkoutDir, timeoutMs: 1_000, env: process.env }),
        ).resolves.toMatchObject({ checkoutDir: targetDir, step: { exitCode: 0 } });

        await expect(fs.readFile(path.join(targetDir, "checkout.marker"), "utf8")).resolves.toBe(
          "complete\n",
        );
        await expect(fs.readdir(replacementDir)).resolves.toEqual([]);
      });
    },
  );

  it.each(["destination", "storage", "repository"] as const)(
    "preserves a replaced %s directory before publication and cleanup",
    async (replaced) => {
      await withTestDir({ prefix: "openclaw-update-clone-replaced-" }, async (base) => {
        const checkoutDir = path.join(base, "openclaw");
        const displacedDir = path.join(base, "displaced");
        await fs.mkdir(checkoutDir);
        runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
          await fs.writeFile(path.join(cloneTarget(argv), "checkout.marker"), "complete\n");
          return successfulCommandResult;
        });
        let replacementStage = "";
        await expect(
          ensureGitCheckout({
            dir: checkoutDir,
            timeoutMs: 1_000,
            env: process.env,
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
        await expect(fs.readFile(path.join(userDir, "user.marker"), "utf8")).resolves.toBe(
          "keep\n",
        );
        if (replaced === "destination") {
          await expect(fs.readdir(checkoutDir)).resolves.toEqual([]);
        } else {
          await expect(fs.readdir(replacementStage)).resolves.toEqual(["user.marker"]);
          await expect(
            fs.readFile(
              path.join(
                displacedDir,
                ...(replaced === "storage" ? ["repository"] : []),
                "checkout.marker",
              ),
              "utf8",
            ),
          ).resolves.toBe("complete\n");
        }
      });
    },
  );

  it.each([
    { published: false, missingStorage: false },
    { published: true, missingStorage: false },
    { published: true, missingStorage: true },
  ])(
    "reports skipped clone cleanup after custody loss (published: $published, missing storage: $missingStorage)",
    async ({ published, missingStorage }) => {
      await withTestDir({ prefix: "openclaw-update-clone-custody-" }, async (base) => {
        const checkoutDir = path.join(base, "openclaw");
        const onStepComplete = vi.fn<NonNullable<UpdateStepProgress["onStepComplete"]>>((step) => {
          if (step.name === "git-clone-staging-cleanup") {
            throw new Error("cleanup warning ledger unavailable");
          }
        });
        let retained = "";
        let publicationError: unknown;
        runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
          await fs.writeFile(path.join(cloneTarget(argv), "checkout.marker"), "complete\n");
          return successfulCommandResult;
        });
        const result = ensureGitCheckout({
          dir: checkoutDir,
          timeoutMs: 1_000,
          env: process.env,
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
          expect(await fs.readFile(path.join(checkoutDir, "checkout.marker"), "utf8")).toBe(
            "complete\n",
          );
          if (!missingStorage) {
            expect(
              await fs.readFile(path.join(retained, "repository", "user.marker"), "utf8"),
            ).toBe("keep\n");
          }
        } else {
          await expect(result).rejects.toThrow("changed before publication");
          await expect(result).rejects.toBe(publicationError);
        }
        if (missingStorage) {
          await expect(fs.stat(retained)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(await fs.readFile(path.join(retained, "build.marker"), "utf8")).toBe("keep\n");
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
      });
    },
  );

  it.each([
    { callbackFails: false, cleanupFailure: "remove" },
    { callbackFails: true, cleanupFailure: "remove" },
    { callbackFails: false, cleanupFailure: "inspect" },
    { callbackFails: true, cleanupFailure: "inspect" },
  ])(
    "preserves the published update outcome when clone cleanup fails ($cleanupFailure, callback fails: $callbackFails)",
    async ({ callbackFails, cleanupFailure }) => {
      await withTestDir({ prefix: "openclaw-update-clone-cleanup-" }, async (base) => {
        const checkoutDir = path.join(base, "openclaw");
        const callbackError = new Error("candidate operation failed");
        const onStepComplete = vi.fn((step: { name: string }) => {
          if (step.name === "git-clone-staging-cleanup") {
            throw new Error("cleanup warning ledger unavailable");
          }
        });
        let retained = "";
        let published = false;
        runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
          await fs.writeFile(path.join(cloneTarget(argv), "checkout.marker"), "complete\n");
          return successfulCommandResult;
        });
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
          const update = ensureGitCheckout({
            dir: checkoutDir,
            timeoutMs: 1_000,
            env: process.env,
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
          if (callbackFails) {
            await expect(update).rejects.toBe(callbackError);
          } else {
            await expect(update).resolves.toMatchObject({
              checkoutDir,
              step: { exitCode: 0, warnings: [expect.stringContaining("cleanup denied")] },
            });
          }
          expect(await fs.readFile(path.join(checkoutDir, "checkout.marker"), "utf8")).toBe(
            "complete\n",
          );
          expect(await fs.readFile(path.join(retained, "build.marker"), "utf8")).toBe("keep\n");
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
      });
    },
  );

  it("retains recovery files when publication and rollback both fail", async () => {
    await withTestDir({ prefix: "openclaw-update-clone-rollback-" }, async (base) => {
      const checkoutDir = path.join(base, "openclaw");
      await fs.mkdir(checkoutDir);
      runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
        const stagingDir = cloneTarget(argv);
        await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
        await fs.writeFile(path.join(stagingDir, "checkout.marker"), "complete\n");
        return successfulCommandResult;
      });

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
        await expect(
          ensureGitCheckout({ dir: checkoutDir, timeoutMs: 1_000, env: process.env }),
        ).rejects.toThrow("recovery files remain");
      } finally {
        rename.mockRestore();
      }

      await expect(fs.readFile(path.join(checkoutDir, "checkout.marker"), "utf8")).resolves.toBe(
        "complete\n",
      );
      const recoveryDirs = (await fs.readdir(checkoutDir)).filter((entry) =>
        entry.startsWith(".openclaw-clone-"),
      );
      expect(recoveryDirs).toHaveLength(1);
      await expect(
        fs.stat(path.join(checkoutDir, recoveryDirs[0]!, "repository", ".git")),
      ).resolves.toBeDefined();
    });
  });
});
