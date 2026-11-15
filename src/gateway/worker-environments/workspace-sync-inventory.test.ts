import { ChildProcess } from "node:child_process";
import { tracingChannel } from "node:diagnostics_channel";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFixtureFile } from "../../../test/helpers/process-wait.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { runWithSpawnBroker } from "../../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../../process/spawn-broker/host.test-support.js";
import { supportsSpawnBrokerCommandTransport } from "../../process/spawn-broker/pipe.js";
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
const startBroker = useSpawnBrokerTestFixture(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function commandFixture() {
  const root = tempDirs.make("openclaw-workspace-inventory-");
  return { root, outputPath: path.join(root, "output"), controller: new AbortController() };
}

function observeCommand(marker: string) {
  const ready = createDeferred();
  const exited = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const closed = vi.fn();
  let stderr = "";
  const channel = tracingChannel("child_process.spawn").start;
  const observe = (message: unknown) => {
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
    child.once("spawn", () =>
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk);
        if (stderr.split("\n").includes("fixture ready")) {
          ready.resolve();
        }
      }),
    );
    child.once("exit", (code, signal) => exited.resolve({ code, signal }));
    child.once("close", closed);
  };
  channel.subscribe(observe);
  return {
    ready,
    exited,
    closed,
    stderr: () => stderr,
    [Symbol.dispose]: () => channel.unsubscribe(observe),
  };
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
  it.skipIf(!supportsSpawnBrokerCommandTransport())(
    "writes inventory files in the broker without forking the Gateway",
    async ({ signal, onTestFinished }) => {
      const broker = await startBroker();
      const { root } = commandFixture();
      const inputPath = path.join(root, "input");
      const payload = Buffer.alloc(256 * 1024, 0x61);
      await fs.writeFile(inputPath, payload);
      for (const bounded of [false, true]) {
        const outputPath = path.join(root, String(bounded));
        await runWithSpawnBroker(broker, () =>
          inventoryCommand(
            [
              process.execPath,
              "-e",
              "process.stdout.write(`${process.ppid}:${require('node:fs').fstatSync(1).isFile()}\\n`); process.stdin.pipe(process.stdout);",
            ],
            outputPath,
            { inputPath, ...(bounded ? { maxOutputBytes: payload.length + 32 } : {}) },
          ),
        );
        const written = await fs.readFile(outputPath);
        const prefix = `${broker!.pid}:${!bounded}\n`;
        expect(written.subarray(0, prefix.length).toString()).toBe(prefix);
        expect(written.subarray(prefix.length)).toEqual(payload);
      }
      await expect(
        runWithSpawnBroker(broker, () =>
          inventoryCommand(
            [process.execPath, "-e", 'process.stdout.write("x".repeat(1024))'],
            path.join(root, "overflow"),
            { maxOutputBytes: 16 },
          ),
        ),
      ).rejects.toThrow("pack exceeds the 16 byte limit");
      const controller = new AbortController();
      const stoppedOutput = path.join(root, "stopped");
      const readyPath = path.join(root, "ready");
      const stopped = runWithSpawnBroker(broker, () =>
        inventoryCommand(
          [
            process.execPath,
            "-e",
            'process.on("SIGTERM", () => {}); process.stdout.write("ready", () => require("node:fs").writeFileSync(process.argv[1], "ready")); setInterval(() => {}, 1000);',
            readyPath,
          ],
          stoppedOutput,
          { signal: controller.signal },
        ),
      ).catch((error: unknown) => error);
      onTestFinished(async () => {
        controller.abort();
        await stopped;
      });
      await withinTest(waitForFixtureFile(readyPath, stopped, "ready"), signal);
      controller.abort();
      expect(await stopped).toBe(controller.signal.reason);
      await expect(fs.readFile(stoppedOutput, "utf8")).resolves.toBe("ready");
    },
  );

  it("persists stdout at its exact output budget", async () => {
    const { outputPath } = commandFixture();
    const expected = Buffer.from("bounded workspace inventory output\n");
    await inventoryCommand(
      [process.execPath, "-e", "process.stdout.write(process.argv[1])", expected.toString()],
      outputPath,
      { maxOutputBytes: expected.length },
    );
    await expect(fs.readFile(outputPath)).resolves.toEqual(expected);
  });

  it("filters missing files from a persisted Git transfer list", async () => {
    const { root, outputPath } = commandFixture();
    const preparedListPath = path.join(root, "prepared");
    await files(root, {
      "alpha.txt": "alpha",
      "nested/beta.txt": "beta",
      prepared: "alpha.txt\0missing.txt\0nested/beta.txt\0",
    });
    await filterExistingGitTransferList({ gitRoot: root, preparedListPath, outputPath });
    await expect(fs.readFile(outputPath)).resolves.toEqual(
      Buffer.from("alpha.txt\0nested/beta.txt\0"),
    );
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

  it("force-kills a command that ignores abort termination", async ({ signal, onTestFinished }) => {
    const { root, outputPath, controller } = commandFixture();
    const marker = path.join(root, "command-identity");
    using observed = observeCommand(marker);
    const operation = inventoryCommand(
      [
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => {}); process.stderr.write("fixture ready\\n"); setInterval(() => {}, 1000);',
        marker,
      ],
      outputPath,
      { signal: controller.signal },
    );
    const cleanup = async () => {
      controller.abort();
      await operation.catch(() => undefined);
    };
    // Retain cleanup when Vitest aborts the body before native termination settles.
    onTestFinished(cleanup);
    try {
      await withinTest(Promise.race([observed.ready.promise, operation]), signal);
      const abortedAt = Date.now();
      controller.abort();
      await expect(operation).rejects.toBe(controller.signal.reason);
      expect(Date.now() - abortedAt).toBeLessThan(3_000);
    } finally {
      await cleanup();
    }
  });

  it("does not create output when opening the input fails", async () => {
    const { root, outputPath } = commandFixture();
    await expect(
      inventoryCommand([process.execPath, "-e", ""], outputPath, {
        inputPath: path.join(root, "missing"),
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
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
      using observed = observeCommand(marker);
      const { ready, exited, closed } = observed;
      const settled = vi.fn();
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
          expect(await exited.promise, observed.stderr()).toEqual({ code: exitCode, signal: null });
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
        expect(await exited.promise, observed.stderr()).toEqual({ code: exitCode, signal: null });
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

    await preflightWorkerWorkspace({ localPath: root });
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

    const error = await preflightWorkerWorkspace({ localPath: root }).catch(
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
