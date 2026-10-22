import { ChildProcess } from "node:child_process";
import { tracingChannel } from "node:diagnostics_channel";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  MAX_WORKSPACE_GIT_CANDIDATES,
  MAX_WORKSPACE_INVENTORY_ENTRIES,
} from "./workspace-inventory-limits.js";
import {
  createWorkspaceGitTransferList,
  filterExistingGitTransferList,
  runWorkspaceInventoryCommandToFile,
} from "./workspace-sync-inventory.js";
import { preflightWorkerWorkspace } from "./workspace-sync-preflight.js";
import { writeWorkspaceFiles as files } from "./workspace-sync-scripts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function commandFixture() {
  const root = tempDirs.make("openclaw-workspace-inventory-");
  return { root, outputPath: path.join(root, "output"), controller: new AbortController() };
}

function injectPositiveShortWrite(targetPath: string): () => boolean {
  let shortWriteObserved = false;
  interceptOutput(targetPath, (handle) => {
    let injectShortWrite = true;
    const injectedHandle = Object.create(handle) as typeof handle;
    injectedHandle.close = handle.close.bind(handle);
    injectedHandle.write = (async (
      data: string | NodeJS.ArrayBufferView,
      offsetOrPosition: number | null = null,
      length?: number | null,
      position?: number | null,
    ) => {
      const buffer =
        typeof data === "string"
          ? Buffer.from(data)
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const offset = typeof data === "string" ? 0 : (offsetOrPosition ?? 0);
      const requested =
        typeof data === "string" ? buffer.length : (length ?? buffer.length - offset);
      const filePosition = typeof data === "string" ? offsetOrPosition : position;
      const writeLength = injectShortWrite ? Math.max(1, Math.floor(requested / 2)) : requested;
      injectShortWrite = false;
      shortWriteObserved ||= writeLength < requested;
      return await handle.write(buffer, offset, writeLength, filePosition);
    }) as typeof handle.write;
    injectedHandle.writeFile = (async (data: string | NodeJS.ArrayBufferView) => {
      const buffer =
        typeof data === "string"
          ? Buffer.from(data)
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await injectedHandle.write(buffer, offset, buffer.length - offset);
        if (bytesWritten === 0) {
          throw new Error("injected file write made no progress");
        }
        offset += bytesWritten;
      }
    }) as typeof handle.writeFile;
    return injectedHandle;
  });
  return () => shortWriteObserved;
}

function interceptOutput(target: string, intercept: (handle: FileHandle) => FileHandle | void) {
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    return typeof args[0] === "string" &&
      path.resolve(args[0]) === path.resolve(target) &&
      args[1] === "wx"
      ? (intercept(handle) ?? handle)
      : handle;
  });
}

async function workspace(entries: Record<string, string> = {}, committed = false) {
  const root = await fs.realpath(tempDirs.make("openclaw-workspace-inventory-"));
  await git(root, "init", "--quiet");
  await files(root, entries);
  if (committed) {
    await git(root, "add", ".");
    await git(root, "commit", "--quiet", "--allow-empty", "-m", "base");
  }
  return root;
}

async function git(root: string, ...args: string[]): Promise<string> {
  const identity = ["-c", "user.name=OpenClaw Test", "-c", "user.email=test@openclaw.invalid"];
  const result = await runCommandWithTimeout(["git", "-C", root, ...identity, ...args], {
    timeoutMs: 10_000,
  });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

function inventoryCommand(
  argv: string[],
  outputPath: string,
  options: Partial<Parameters<typeof runWorkspaceInventoryCommandToFile>[0]> = {},
) {
  return runWorkspaceInventoryCommandToFile({
    argv,
    outputPath,
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    ...options,
  });
}

function transferList(
  gitRoot: string,
  temporaryDirectory: string,
  options: Partial<Parameters<typeof createWorkspaceGitTransferList>[0]> = {},
) {
  return createWorkspaceGitTransferList({
    gitRoot,
    temporaryDirectory,
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    ...options,
  });
}

describe("runWorkspaceInventoryCommandToFile", () => {
  it("fully persists bounded stdout after a positive short write", async () => {
    const { outputPath } = commandFixture();
    const expected = Buffer.from("bounded workspace inventory output\n");
    const shortWriteObserved = injectPositiveShortWrite(outputPath);

    await inventoryCommand(
      [process.execPath, "-e", "process.stdout.write(process.argv[1])", expected.toString()],
      outputPath,
      { maxOutputBytes: expected.length },
    );

    expect(shortWriteObserved()).toBe(true);
    await expect(fs.readFile(outputPath)).resolves.toEqual(expected);
  });

  it.each(
    (["inventory", "metadata"] as const).flatMap((operation) =>
      [
        { firstFailure: "ignored" as const, cancelRemaining: false },
        { firstFailure: "selected" as const, cancelRemaining: false },
        { firstFailure: "ignored" as const, cancelRemaining: true },
        { firstFailure: "selected" as const, cancelRemaining: true },
        { firstFailure: undefined, cancelRemaining: true },
      ].map(({ firstFailure, cancelRemaining }) => ({ firstFailure, cancelRemaining, operation })),
    ),
  )(
    "settles $operation writers when $firstFailure fails first (cancel=$cancelRemaining)",
    async ({ operation, firstFailure, cancelRemaining }) => {
      const controller = new AbortController();
      const root = await workspace({ ".worktreeinclude": "selected.txt\n" });
      const temporaryDirectory = path.join(tempDirs.make("openclaw-transfer-"), "inventory");
      const started = createDeferred();
      const cancellation = new Error("inventory stopped");
      const release = { ignored: createDeferred(), selected: createDeferred() };
      const errors = {
        ignored: new Error("ignored inventory writer failed"),
        selected: new Error("selected inventory writer failed"),
      };
      const observed = new Set<string>();
      const outputNames =
        operation === "inventory"
          ? { ignored: "ignored", selected: "selected" }
          : { ignored: "git-root", selected: "base-commit" };
      let commandDirectory = operation === "inventory" ? temporaryDirectory : undefined;
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const target = args[0];
        if (typeof target === "string") {
          const basename = path.basename(target);
          const name =
            basename === outputNames.ignored
              ? "ignored"
              : basename === outputNames.selected
                ? "selected"
                : undefined;
          if (
            name &&
            (commandDirectory === undefined || path.dirname(target) === commandDirectory)
          ) {
            commandDirectory ??= path.dirname(target);
            observed.add(name);
            started.resolve();
            await release[name].promise;
            if (!cancelRemaining || name === firstFailure) {
              throw errors[name];
            }
          }
        }
        return await originalOpen(...args);
      });
      const producing =
        operation === "inventory"
          ? transferList(root, temporaryDirectory, { signal: controller.signal })
          : preflightWorkerWorkspace({
              localPath: root,
              signal: controller.signal,
              timeoutMs: 10_000,
            });
      const settled = vi.fn();
      void producing.then(settled, settled);
      try {
        await Promise.race([started.promise, producing]);
        expect(observed).toEqual(new Set(["ignored", "selected"]));
        if (firstFailure) {
          release[firstFailure].resolve();
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).not.toHaveBeenCalled();
        if (cancelRemaining) {
          controller.abort(cancellation);
        }
        release.ignored.resolve();
        release.selected.resolve();
        await expect(producing).rejects.toBe(
          cancelRemaining ? (firstFailure ? errors[firstFailure] : cancellation) : errors.ignored,
        );
      } finally {
        release.ignored.resolve();
        release.selected.resolve();
        await producing.catch(() => undefined);
      }
    },
  );

  it("fully persists a filtered Git transfer list after a positive short write", async () => {
    const { root, outputPath } = commandFixture();
    const preparedListPath = path.join(root, "prepared");
    await files(root, {
      "alpha.txt": "alpha",
      "nested/beta.txt": "beta",
      prepared: "alpha.txt\0missing.txt\0nested/beta.txt\0",
    });
    const shortWriteObserved = injectPositiveShortWrite(outputPath);

    await filterExistingGitTransferList({ gitRoot: root, preparedListPath, outputPath });

    expect(shortWriteObserved()).toBe(true);
    await expect(fs.readFile(outputPath)).resolves.toEqual(
      Buffer.from("alpha.txt\0nested/beta.txt\0"),
    );
  });

  it("force-kills a command that ignores abort termination", async ({ signal, onTestFinished }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-sync-"));
    const outputPath = path.join(root, "output");
    const controller = new AbortController();
    const readyPath = path.join(root, "ready");
    const operation = inventoryCommand(
      [
        process.execPath,
        "--input-type=module",
        "-e",
        [
          'import fs from "node:fs";',
          fixtureReceiptClientSource(receipts.endpoint),
          'process.on("SIGTERM", () => {});',
          'fs.writeFileSync(process.argv[1], "ready");',
          'sendReceipt(process.argv[1], "ready");',
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        readyPath,
      ],
      outputPath,
      { signal: controller.signal },
    );
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        controller.abort();
        await operation.catch(() => undefined);
        await fs.rm(root, { recursive: true, force: true });
      })());
    // A timed-out body starts finally but Vitest does not join it; the hook retains
    // the worker until the command's delayed force-kill and cleanup have finished.
    onTestFinished(cleanup);

    try {
      // Receipts and command completion use separate pipes; the durable marker decides
      // readiness if the operation settles before the receipt reaches this process.
      const readReady = () =>
        fs.readFile(readyPath, "utf8").catch((error: unknown) => {
          if (hasErrnoCode(error, "ENOENT")) {
            return "";
          }
          throw error;
        });
      await withinTest(
        Promise.race([
          receipts.waitFor(readyPath, "ready"),
          operation
            .then(
              () => new Error(`Timed out waiting for ${readyPath}`),
              (error: unknown) => error,
            )
            .then(async (error) => {
              if ((await readReady()) !== "ready") {
                throw error;
              }
            }),
        ]),
        signal,
      );
      const abortedAt = Date.now();
      controller.abort();
      await expect(operation).rejects.toBe(controller.signal.reason);
      expect(Date.now() - abortedAt).toBeLessThan(3_000);
    } finally {
      await cleanup();
    }
  });

  it("closes its output when opening the input fails", async () => {
    const { root, outputPath } = commandFixture();
    let output: Awaited<ReturnType<typeof fs.open>> | undefined;
    interceptOutput(outputPath, (handle) => {
      output = handle;
    });
    try {
      await expect(
        inventoryCommand([process.execPath, "-e", ""], outputPath, {
          inputPath: path.join(root, "missing"),
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(output).toBeDefined();
      await expect(output!.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      await output?.close();
    }
  });

  // Windows taskkill cannot recover descendants after their parent has exited.
  it
    .skipIf(process.platform === "win32")
    .each(["ordinary-exit", "abort-exit", "timeout-exit", "timeout-clean-exit"] as const)(
    "preserves the command outcome before delayed stdio close (%s)",
    async (mode) => {
      const { root, outputPath, controller } = commandFixture();
      const marker = path.join(root, "command-identity");
      const cancellation = new Error("inventory stopped after command outcome");
      const timeout = mode.startsWith("timeout-");
      const exitCode = mode === "timeout-clean-exit" ? 0 : 7;
      const ready = createDeferred();
      const exited = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
      const closed = vi.fn();
      const settled = vi.fn();
      let observedStderr = "";
      const spawnChannel = tracingChannel("child_process.spawn").start;
      const observeSpawn = (message: unknown) => {
        if (
          !message ||
          typeof message !== "object" ||
          !("process" in message) ||
          !(message.process instanceof ChildProcess) ||
          !message.process.spawnargs.includes(marker)
        ) {
          return;
        }
        const child = message.process;
        child.once("spawn", () => {
          child.stderr?.on("data", (chunk: Buffer | string) => {
            observedStderr += String(chunk);
            if (observedStderr.split("\n").includes("fixture ready")) {
              ready.resolve();
            }
          });
        });
        child.once("exit", (code, signal) => exited.resolve({ code, signal }));
        child.once("close", closed);
      };
      spawnChannel.subscribe(observeSpawn);
      const descendant = [
        'process.on("SIGTERM", () => {});',
        'process.send("ready"); process.disconnect();',
        "setInterval(() => {}, 1000);",
      ].join("");
      const script = [
        'const { spawn } = require("node:child_process");',
        `process.on("SIGTERM", () => process.exit(${exitCode}));`,
        'process.stdout.write("partial inventory\\n");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "ignore", 2, "ipc"] });`,
        "child.unref();",
        'child.once("message", () => process.stderr.write("fixture ready\\n", () => {',
        mode === "ordinary-exit"
          ? 'process.stderr.write("ordinary inventory failure\\n", () => process.exit(7));'
          : "setInterval(() => {}, 1000);",
        "}));",
      ].join("");
      if (timeout) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const producing = inventoryCommand([process.execPath, "-e", script, marker], outputPath, {
        signal: controller.signal,
      });
      void producing.then(settled, settled);
      try {
        await ready.promise;
        if (timeout) {
          await vi.advanceTimersByTimeAsync(10_000);
        }
        if (mode !== "abort-exit") {
          expect(await exited.promise, observedStderr).toEqual({ code: exitCode, signal: null });
        }
        expect(closed).not.toHaveBeenCalled();
        expect(settled).not.toHaveBeenCalled();
        if (mode !== "timeout-clean-exit") {
          controller.abort(cancellation);
        }
        if (timeout) {
          await vi.advanceTimersByTimeAsync(300);
        }
        const error = await producing.catch((value: unknown) => value);
        expect(await exited.promise, observedStderr).toEqual({ code: exitCode, signal: null });
        expect(closed).toHaveBeenCalledOnce();
        if (mode === "ordinary-exit") {
          expect(error).toMatchObject({
            message: expect.stringContaining("ordinary inventory failure"),
          });
        } else if (timeout) {
          expect(error).toMatchObject({
            message: expect.stringContaining("file enumeration failed: timed out after 10000ms"),
          });
          await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("partial inventory\n");
        } else {
          expect(error).toBe(cancellation);
        }
      } finally {
        controller.abort(cancellation);
        if (timeout) {
          await vi.runOnlyPendingTimersAsync();
          vi.useRealTimers();
        }
        await producing.catch(() => undefined);
        spawnChannel.unsubscribe(observeSpawn);
      }
    },
  );

  it("stops a pack producer before it can exceed its output budget", async () => {
    const { root } = commandFixture();
    const outputPath = path.join(root, "pack");

    await expect(
      inventoryCommand(
        [process.execPath, "-e", 'process.stdout.write("x".repeat(1024))'],
        outputPath,
        { maxOutputBytes: 16 },
      ),
    ).rejects.toThrow("pack exceeds the 16 byte limit");
    await expect(fs.stat(outputPath)).resolves.toMatchObject({ size: 0 });
  });

  it("bounds raw Git candidates before materializing the eligible inventory", async () => {
    const { root } = commandFixture();
    const bin = path.join(root, "bin");
    const mockGit = path.join(bin, "git");
    const countFile = path.join(bin, "git-entry-count");
    const transfers = tempDirs.make("openclaw-transfers-");
    const firstTransfer = path.join(transfers, "accepted");
    const secondTransfer = path.join(transfers, "rejected");
    // Rewriting an executed script between spawns races exec against a forked
    // child still holding the write fd (ETXTBSY). Write the script once and
    // vary only a data file it reads.
    await fs.mkdir(bin);
    await fs.writeFile(
      mockGit,
      `#!/usr/bin/env node
const fs = require("node:fs");
const count = Number(fs.readFileSync(${JSON.stringify(countFile)}, "utf8"));
process.stdout.write("eligible.txt\\0".repeat(count));
`,
      { mode: 0o755 },
    );
    await fs.writeFile(path.join(root, "eligible.txt"), "eligible\n");
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    await fs.writeFile(countFile, String(MAX_WORKSPACE_INVENTORY_ENTRIES + 1));

    const acceptedPath = await transferList(root, firstTransfer, { timeoutMs: 20_000 });
    expect((await fs.readFile(acceptedPath, "utf8")).split("\0").filter(Boolean)).toEqual([
      "eligible.txt",
    ]);

    await fs.writeFile(countFile, String(MAX_WORKSPACE_GIT_CANDIDATES + 1));
    await expect(transferList(root, secondTransfer, { timeoutMs: 20_000 })).rejects.toThrow(
      `exceed the ${MAX_WORKSPACE_GIT_CANDIDATES} limit`,
    );
  }, 30_000);
});

describe("preflightWorkerWorkspace", () => {
  it("inspects workspace files outside the Gateway thread", async () => {
    const root = await workspace({}, true);
    const file = path.join(root, "content.txt");
    await fs.writeFile(file, "content\n");
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (args[0] === file) {
        throw new Error("Workspace file inspection ran on the Gateway thread");
      }
      return await originalLstat(...args);
    });
    await expect(preflightWorkerWorkspace({ localPath: root })).resolves.toBeUndefined();
  });

  it.each(["complete", "abort", "write-failure"] as const)(
    "settles worker inventory output before completing (%s)",
    async (outcome) => {
      const controller = new AbortController();
      const root = await workspace({ "alpha.txt": "alpha\n", "beta.txt": "beta\n" });
      const scratch = tempDirs.make("openclaw-workspace-transfer-output-");
      const temporaryDirectory = path.join(scratch, "first");
      const outputPath = path.join(temporaryDirectory, "transfer-list");
      const entered = createDeferred();
      const release = createDeferred();
      const cancellation = new Error("workspace preparation stopped");
      const writeFailure = new Error("inventory output failed");
      let settled = false;
      let closed = false;
      interceptOutput(outputPath, (handle) => {
        const writeFile = handle.writeFile.bind(handle);
        const close = handle.close.bind(handle);
        handle.writeFile = async (...writeArgs) => {
          entered.resolve();
          await release.promise;
          if (outcome === "write-failure") {
            throw writeFailure;
          }
          return await writeFile(...writeArgs);
        };
        handle.close = async () => {
          closed = true;
          await close();
        };
      });
      const producing = transferList(root, temporaryDirectory, { signal: controller.signal })
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      try {
        await Promise.race([
          entered.promise,
          producing.then(() => {
            throw new Error("Inventory ended before reaching its output writer");
          }),
        ]);
        if (outcome === "abort") {
          controller.abort(cancellation);
          const independent = await transferList(root, path.join(scratch, "second"));
          await expect(fs.readFile(independent, "utf8")).resolves.toBe("alpha.txt\0beta.txt\0");
        }
        expect({ settled, closed }).toEqual({ settled: false, closed: false });
      } finally {
        release.resolve();
        await producing;
      }
      const result = await producing;
      expect(closed).toBe(true);
      if (outcome === "complete") {
        expect(result).toBe(outputPath);
        await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("alpha.txt\0beta.txt\0");
      } else {
        expect(result).toBe(outcome === "abort" ? cancellation : writeFailure);
      }
    },
  );

  it("measures the canonical Git eligibility boundary without hashing content", async () => {
    const root = await workspace(
      {
        ".gitignore": "ignored/**\n",
        ".worktreeinclude": "ignored/selected.txt\n",
        "tracked.txt": "tracked\n",
        "missing.txt": "sparse\n",
      },
      true,
    );
    const transferDirectory = path.join(tempDirs.make("openclaw-transfer-"), "inventory");
    await fs.rm(path.join(root, "missing.txt"));
    await files(root, {
      "ordinary.txt": "ordinary\n",
      "ignored/selected.txt": "selected\n",
      "ignored/secret.txt": "secret\n",
      "__pycache__/cache.pyc": "derived\n",
      "nested/private.txt": "nested\n",
    });
    await fs.symlink("tracked.txt", path.join(root, "safe-link"));
    await git(path.join(root, "nested"), "init", "--quiet");

    await preflightWorkerWorkspace({ localPath: root, timeoutMs: 10_000 });
    const transferPath = await transferList(root, transferDirectory);
    const paths = new Set((await fs.readFile(transferPath, "utf8")).split("\0").filter(Boolean));

    expect(paths).toEqual(
      new Set([
        ".gitignore",
        ".worktreeinclude",
        "ignored/selected.txt",
        "ordinary.txt",
        "safe-link",
        "tracked.txt",
      ]),
    );
  });

  it("rejects escaping symlinks with a typed bounded error", async () => {
    const root = await workspace({ "tracked.txt": "tracked\n" }, true);
    await fs.symlink("../outside", path.join(root, "escape"));

    const error = await preflightWorkerWorkspace({ localPath: root, timeoutMs: 10_000 }).catch(
      (value: unknown) => value,
    );

    expect(error).toMatchObject({
      name: "WorkerWorkspacePreflightError",
      code: "invalid_state",
      message: expect.stringContaining("escapes the sync root"),
    });
    expect((error as Error).message.length).toBeLessThanOrEqual(1_024);
  });

  it("preserves filesystem and abort failures as operational errors", async () => {
    const controller = new AbortController();
    const missingParent = tempDirs.make("openclaw-workspace-missing-");
    const root = await workspace();
    const missing = await preflightWorkerWorkspace({
      localPath: path.join(missingParent, "absent"),
    }).catch((value: unknown) => value);
    expect(missing).not.toMatchObject({ name: "WorkerWorkspacePreflightError" });
    expect(missing).toMatchObject({ code: "ENOENT" });

    controller.abort();
    const aborted = await preflightWorkerWorkspace({
      localPath: root,
      signal: controller.signal,
    }).catch((value: unknown) => value);
    expect(aborted).not.toMatchObject({ name: "WorkerWorkspacePreflightError" });
    expect((aborted as Error).message).toContain("aborted");
  });
});
