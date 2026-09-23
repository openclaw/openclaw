import { deserialize } from "node:v8";
import type {
  FsSafeCopyRead,
  FsSafeCopyReply,
  FsSafeCopyWrite,
} from "../../infra/fs-safe-copy-worker-contract.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { WorkerTaskError, WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { runCommandBuffersWithTimeout } from "../../process/exec-runner.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
import { WORKTREE_CHECKOUT_TIMEOUT_MS } from "./git.js";

type ReadRuntime = {
  pool?: WorkerTaskPool<FsSafeCopyRead, FsSafeCopyReply>;
  closing?: Promise<void>;
};

function workerUrl(): URL {
  return resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.fsSafeCopy);
}

function assertActive(options: WorktreeFilesystemOptions): void {
  options.signal?.throwIfAborted();
  options.commitGuard();
}

function checkReply(reply: FsSafeCopyReply): void {
  if (reply.type === "failed") {
    throw Object.assign(new Error(reply.message), { code: reply.code });
  }
}

async function read(
  command: FsSafeCopyRead,
  options: WorktreeFilesystemOptions,
): Promise<FsSafeCopyReply> {
  assertActive(options);
  const runtime = resolveGlobalSingleton<ReadRuntime>(
    Symbol.for("openclaw.worktreeFilesystemReads"),
    () => ({}),
    (owned) => {
      owned.closing ??= (owned.pool?.close() ?? Promise.resolve()).finally(() => {
        owned.pool = undefined;
        owned.closing = undefined;
      });
      return owned.closing;
    },
  );
  if (runtime.closing) {
    throw new WorkerTaskError(
      "Native worktree reads are closing; retry the operation",
      "unavailable",
    );
  }
  const pool = (runtime.pool ??= new WorkerTaskPool<FsSafeCopyRead, FsSafeCopyReply>({
    workerUrl: workerUrl(),
    maxWorkers: 1,
    idleTimeoutMs: 30_000,
  }));
  const reply = await pool.run(command, {
    inputBytes:
      command.type === "probe"
        ? Buffer.byteLength(command.parent)
        : command.paths.reduce((bytes, pathname) => bytes + Buffer.byteLength(pathname), 0),
    signal: options.signal,
    timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
  });
  assertActive(options);
  checkReply(reply);
  return reply;
}

async function write(command: FsSafeCopyWrite, options: WorktreeFilesystemOptions): Promise<void> {
  assertActive(options);
  // A process owns its descriptor table. Never terminate a JS worker while
  // fs-safe's native task still borrows descriptors opened by that worker.
  const result = await runCommandBuffersWithTimeout(
    [process.execPath, ...resolveRuntimeWorkerArgv(workerUrl())],
    {
      input: JSON.stringify(command),
      beforeInput: () => assertActive(options),
      signal: options.signal,
      timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
      killGraceMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      maxOutputBytes: 64 * 1024,
    },
  );
  assertActive(options);
  if (result.code !== 0 || result.termination !== "exit") {
    throw new Error(`Native worktree ${command.type} failed: ${result.termination}`);
  }
  // SAFETY: The private child returns a serialized reply only after its native call settles.
  const reply = deserialize(result.stdout) as FsSafeCopyReply;
  checkReply(reply);
  if (reply.type !== "written") {
    throw new Error("Native worktree operation returned no completion receipt");
  }
}

export const nativeWorktreeFilesystem = {
  async probe(this: void, parent: string, options: WorktreeFilesystemOptions) {
    const reply = await read({ type: "probe", parent }, options);
    if (reply.type !== "probe") {
      throw new Error("Native worktree probe returned an invalid reply");
    }
    return reply.backend;
  },
  async readMetadata(this: void, paths: string[], options: WorktreeFilesystemOptions) {
    const reply = await read({ type: "metadata", paths }, options);
    if (reply.type !== "metadata") {
      throw new Error("Native worktree metadata returned an invalid reply");
    }
    return reply.entries;
  },
  createSource(this: void, destination: string, options: WorktreeFilesystemOptions) {
    return write({ type: "create", destination }, options);
  },
  copy(this: void, source: string, destination: string, options: WorktreeFilesystemOptions) {
    return write({ type: "copy", source, destination }, options);
  },
};
