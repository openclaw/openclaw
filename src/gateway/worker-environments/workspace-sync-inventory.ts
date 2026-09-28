import { spawn } from "node:child_process";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { STAGED_INPUT_GIT_PATHSPEC } from "../../media/staged-inputs.js";
import { killProcessTree } from "../../process/kill-tree.js";
import { workerSshCommandOptions } from "./ssh.js";
import type { WorkspaceInventoryWriteCommand } from "./workspace-inventory-computation.js";
import { workspaceInventoryError } from "./workspace-inventory-error.js";

const STDERR_LIMIT = 4_096;
const COMMAND_KILL_GRACE_MS = 300;

/** Exact rsync exemptions, prepared once without walking input file contents. */
export async function readWorkspaceStagedInputDirectories(rootDir: string): Promise<string[]> {
  return await runGitWorkerOperation(
    { type: "workspace.inventory.staged-directories", input: { rootDir } },
    { inputBytes: Buffer.byteLength(rootDir) },
  );
}

export async function readWorkspaceTransferPaths(
  filePath: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  return await runGitWorkerOperation(
    { type: "workspace.inventory.paths", input: { filePath } },
    { signal, inputBytes: Buffer.byteLength(filePath) },
  );
}

async function writeInventory(
  command: WorkspaceInventoryWriteCommand,
  outputPath: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const output = await fs.open(outputPath, "wx", 0o600);
  try {
    await runGitWorkerOperation(command, {
      signal,
      inputBytes: Object.values(command.input).reduce(
        (bytes, value) => bytes + Buffer.byteLength(value),
        0,
      ),
      onInventoryChunk: async (bytes, context) => {
        context.signal.throwIfAborted();
        await output.writeFile(bytes);
        context.signal.throwIfAborted();
      },
    });
    signal?.throwIfAborted();
    return outputPath;
  } finally {
    await output.close();
  }
}

export async function filterExistingGitTransferList(params: {
  gitRoot: string;
  preparedListPath: string;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<string> {
  return await writeInventory(
    {
      type: "workspace.inventory.existing",
      input: { gitRoot: params.gitRoot, preparedListPath: params.preparedListPath },
    },
    params.outputPath,
    params.signal,
  );
}

export async function runWorkspaceInventoryCommandToFile(params: {
  argv: string[];
  inputPath?: string;
  outputPath: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes?: number;
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<void> {
  const [command, ...args] = params.argv;
  if (!command) {
    throw new Error("Worker workspace command requires an executable");
  }
  const output = await fs.open(params.outputPath, "wx", 0o600);
  let input: FileHandle | undefined;
  let stderr = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let abortedCommand = false;
  let outputError: Error | undefined;
  let outputBytes = 0;
  let outputWrite = Promise.resolve();
  try {
    input = params.inputPath ? await fs.open(params.inputPath, "r") : undefined;
    params.signal.throwIfAborted();
    const boundedOutput = params.maxOutputBytes !== undefined;
    const child = spawn(command, args, {
      env: params.baseEnv ?? workerSshCommandOptions({ timeoutMs: params.timeoutMs }).baseEnv,
      stdio: [input?.fd ?? "ignore", boundedOutput ? "pipe" : output.fd, "pipe"],
      ...(process.platform !== "win32" ? { detached: true } : {}),
      windowsHide: true,
    });
    const childStderr = child.stderr;
    if (!childStderr) {
      throw new Error("Worker workspace command has no stderr pipe");
    }
    childStderr.setEncoding("utf8");
    childStderr.on("data", (chunk: string) => {
      stderr = sliceUtf16Safe(`${stderr}${chunk}`, -STDERR_LIMIT);
    });
    const result = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      let settled = false;
      const finish = (value: { code: number | null; error?: Error }) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      let terminationStarted = false;
      const terminate = () => {
        if (settled || terminationStarted) {
          return;
        }
        terminationStarted = true;
        const pid = child.pid;
        if (typeof pid === "number" && pid > 0) {
          killProcessTree(pid, {
            graceMs: COMMAND_KILL_GRACE_MS,
            detached: process.platform !== "win32",
          });
        } else {
          child.kill("SIGTERM");
        }
        // A descendant can retain stderr even after the direct child exits. Bound
        // shutdown so placement replacement cannot wait forever on that pipe.
        terminationTimer = setTimeout(() => {
          if (typeof pid === "number" && pid > 0) {
            killProcessTree(pid, { force: true, detached: process.platform !== "win32" });
          } else {
            child.kill("SIGKILL");
          }
          childStderr.destroy();
          finish({ code: child.exitCode });
        }, COMMAND_KILL_GRACE_MS + 1_000);
        terminationTimer.unref?.();
      };
      if (boundedOutput) {
        const childStdout = child.stdout;
        if (!childStdout) {
          finish({ code: null, error: new Error("Worker workspace command has no stdout pipe") });
          return;
        }
        childStdout.on("data", (value: Buffer | Uint8Array) => {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          outputBytes += chunk.byteLength;
          if (outputBytes > params.maxOutputBytes!) {
            outputError = workspaceInventoryError(
              `Cloud workspace pack exceeds the ${params.maxOutputBytes} byte limit`,
            );
            terminate();
            return;
          }
          childStdout.pause();
          outputWrite = outputWrite
            .then(async () => {
              await output.writeFile(chunk);
              childStdout.resume();
            })
            .catch((error: unknown) => {
              outputError = error instanceof Error ? error : new Error(String(error));
              terminate();
            });
        });
        childStdout.once("error", (error) => {
          outputError = error;
          terminate();
        });
      }
      child.once("error", (error) => finish({ code: null, error }));
      child.once("close", (code) => finish({ code }));
      abort = () => {
        // Record interruption before pipes drain; a late abort must not hide a failed exit.
        abortedCommand =
          !terminationStarted && child.exitCode === null && child.signalCode === null;
        terminate();
      };
      params.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(terminate, params.timeoutMs);
      timer.unref?.();
      if (params.signal.aborted) {
        abort();
      }
    });
    await outputWrite;
    if (outputError) {
      throw outputError;
    }
    if (result.error) {
      throw result.error;
    }
    if (abortedCommand) {
      params.signal.throwIfAborted();
    }
    if (result.code !== 0) {
      throw new Error(
        stderr.trim()
          ? `Worker workspace file enumeration failed: ${stderr.trim()}`
          : "Worker workspace file enumeration failed",
      );
    }
    params.signal.throwIfAborted();
  } finally {
    clearTimeout(timer);
    clearTimeout(terminationTimer);
    if (abort) {
      params.signal.removeEventListener("abort", abort);
    }
    await output.close();
    await input?.close();
  }
}

export async function settleWorkspaceInventoryCommands(
  commands: Promise<void>[],
  signal: AbortSignal,
): Promise<void> {
  // Join every scratch-file writer before cleanup, preserving independent failures
  // ahead of cancellation so Move cannot mistake failed preflight for a clean Stop.
  for (const result of await Promise.allSettled(commands)) {
    if (result.status === "rejected" && (!signal.aborted || result.reason !== signal.reason)) {
      throw result.reason;
    }
  }
  signal.throwIfAborted();
}

export async function createWorkspaceGitTransferList(params: {
  gitRoot: string;
  temporaryDirectory: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<string> {
  const eligiblePath = path.join(params.temporaryDirectory, "eligible");
  const ignoredPath = path.join(params.temporaryDirectory, "ignored");
  const selectedPath = path.join(params.temporaryDirectory, "selected");
  const outputPath = path.join(params.temporaryDirectory, "transfer-list");
  const listFiles = (args: string[], destination: string) =>
    runWorkspaceInventoryCommandToFile({
      argv: ["git", "-C", params.gitRoot, "ls-files", "--full-name", ...args],
      outputPath: destination,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
    });
  await fs.mkdir(params.temporaryDirectory, { mode: 0o700 });
  await listFiles(["--cached", "--others", "--exclude-standard", "-z"], eligiblePath);
  const worktreeIncludePath = path.join(params.gitRoot, ".worktreeinclude");
  const worktreeInclude = await fs.lstat(worktreeIncludePath).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
      return undefined;
    }
    throw error;
  });
  const hasWorktreeInclude = worktreeInclude?.isFile() === true;
  await settleWorkspaceInventoryCommands(
    [
      listFiles(
        [
          "--others",
          "--ignored",
          "--exclude-standard",
          "-z",
          ...(hasWorktreeInclude ? [] : ["--", STAGED_INPUT_GIT_PATHSPEC]),
        ],
        ignoredPath,
      ),
      hasWorktreeInclude
        ? listFiles(
            ["--others", "--ignored", `--exclude-from=${worktreeIncludePath}`, "-z"],
            selectedPath,
          )
        : fs.writeFile(selectedPath, "", { mode: 0o600 }),
    ],
    params.signal,
  );
  await writeInventory(
    {
      type: "workspace.inventory.select",
      input: { gitRoot: params.gitRoot, eligiblePath, ignoredPath, selectedPath },
    },
    outputPath,
    params.signal,
  );
  return outputPath;
}
