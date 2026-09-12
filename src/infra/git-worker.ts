import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Transferable } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  GitWorktreeEffect,
  GitWorktreeEffectResult,
} from "../agents/worktrees/git-worktree-operations.js";
import { runGitBytes, runGitBuffered } from "../agents/worktrees/git.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  ownedGitWorkerBytes,
  restoreGitWorkerFailure,
  serializeGitWorkerFailure,
} from "./git-worker-context.js";
import type {
  GitWorkerCommand,
  GitWorkerHostRequest,
  GitWorkerOperations,
  GitWorkerReply,
  GitWorkerResult,
} from "./git-worker-contract.js";
import { GIT_WORKER_HOST_BATCH_LIMIT } from "./git-worker-contract.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { WorkerTaskError, WorkerTaskPool, type WorkerTaskResponse } from "./worker-task-pool.js";

type GitPool = WorkerTaskPool<GitWorkerCommand, GitWorkerReply<GitWorkerResult>>;
type GitWorkerRuntime = {
  reads?: GitPool;
  worktrees?: GitPool;
  pending: Set<Promise<unknown>>;
  closing?: Promise<void>;
};
const MAX_PENDING_OPERATIONS = 128;
const WORKER_PHASE_TIMEOUT_MS = 30 * 60_000;

function runtime(): GitWorkerRuntime {
  return resolveGlobalSingleton<GitWorkerRuntime>(
    Symbol.for("openclaw.gitOperations"),
    () => ({ pending: new Set() }),
    (state) => {
      state.closing ??= (async () => {
        await Promise.all([state.reads?.close(), state.worktrees?.close()]);
        // Worker termination alone does not settle its parent-owned Git processes.
        await Promise.allSettled(state.pending);
        state.reads = undefined;
        state.worktrees = undefined;
      })().finally(() => {
        state.closing = undefined;
      });
      return state.closing;
    },
  );
}

function poolFor(state: GitWorkerRuntime, command: GitWorkerCommand): GitPool {
  const owner = command.type.startsWith("worktree.") ? "worktrees" : "reads";
  // Long snapshot work cannot consume the workers needed by interactive reads.
  return (state[owner] ??= new WorkerTaskPool({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.gitOperations),
    maxWorkers: owner === "worktrees" ? 1 : Math.max(1, Math.min(2, os.availableParallelism() - 1)),
    idleTimeoutMs: 30_000,
  }));
}

export type GitWorkerOperationOptions = {
  signal?: AbortSignal;
  assertCurrent?: () => void;
  onEffect?: (
    effect: GitWorktreeEffect,
    context: { signal: AbortSignal },
  ) => Promise<GitWorktreeEffectResult> | GitWorktreeEffectResult;
};

/** The host retains processes and authority; workers own bounded inventory and projection work. */
export async function runGitWorkerOperation<Command extends GitWorkerCommand>(
  command: Command,
  options: GitWorkerOperationOptions = {},
): Promise<GitWorkerOperations[Command["type"]]["output"]> {
  const state = runtime();
  if (state.closing || state.pending.size >= MAX_PENDING_OPERATIONS) {
    throw new WorkerTaskError(
      "Git operation capacity is unavailable; retry the request.",
      "unavailable",
    );
  }
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
  // Capture inputs and environment at admission; neither queued callers nor reused workers own them.
  const admitted = structuredClone(command);
  const baseEnv = { ...process.env };
  const operation = executeOperation(poolFor(state, admitted), admitted, baseEnv, { ...options });
  state.pending.add(operation);
  void operation.then(
    () => state.pending.delete(operation),
    () => state.pending.delete(operation),
  );
  // SAFETY: Private typed workers bind the operation discriminant to this result contract.
  return operation as Promise<GitWorkerOperations[Command["type"]]["output"]>;
}

async function executeOperation(
  pool: GitPool,
  command: GitWorkerCommand,
  baseEnv: NodeJS.ProcessEnv,
  options: GitWorkerOperationOptions,
): Promise<GitWorkerResult> {
  const hostWork = new Set<Promise<WorkerTaskResponse>>();
  const temporaryDirectories = new Set<string>();
  const hostErrors = new Map<number, unknown>();
  let errorSequence = 0;
  const request = async (value: unknown, signal: AbortSignal): Promise<WorkerTaskResponse> => {
    try {
      signal.throwIfAborted();
      if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.input)) {
        throw new Error("Invalid Git worker host request");
      }
      // SAFETY: Only the registered typed operation worker can send requests on this live channel.
      const effect = value as GitWorkerHostRequest;
      let result: unknown;
      const transferList: Transferable[] = [];
      if (effect.type === "git.text") {
        const output = await runGitBytes(effect.input.cwd, effect.input.args, {
          ...effect.input.options,
          baseEnv,
          signal,
          beforeRun: options.assertCurrent,
          killProcessTree: true,
        });
        const stdout = ownedGitWorkerBytes(output.stdout);
        const stderr = ownedGitWorkerBytes(output.stderr);
        result = { ...output, stdout, stderr };
        transferList.push(stdout.buffer, stderr.buffer);
      } else if (effect.type === "git.buffer") {
        const output = await runGitBuffered(effect.input.cwd, effect.input.args, {
          ...effect.input.options,
          baseEnv,
          signal,
          beforeRun: options.assertCurrent,
          killProcessTree: true,
        });
        const stdout = ownedGitWorkerBytes(output.stdout);
        const stderr = ownedGitWorkerBytes(output.stderr);
        result = { ...output, stdout, stderr };
        transferList.push(stdout.buffer, stderr.buffer);
      } else if (effect.type === "git.temporary-directory") {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-operation-"));
        temporaryDirectories.add(directory);
        result = directory;
      } else {
        if (!options.onEffect) {
          throw new Error("Git read operation requested a lifecycle effect");
        }
        options.assertCurrent?.();
        result = await options.onEffect(effect, { signal });
      }
      return {
        input: { ok: true, value: result },
        transferList: [...new Set(transferList)],
        timeoutMs: WORKER_PHASE_TIMEOUT_MS,
      };
    } catch (error) {
      const origin = ++errorSequence;
      hostErrors.set(origin, error);
      return {
        input: { ok: false, error: { ...serializeGitWorkerFailure(error), origin } },
        timeoutMs: WORKER_PHASE_TIMEOUT_MS,
      };
    }
  };
  try {
    const reply = await pool.run(command, {
      signal: options.signal,
      timeoutMs: WORKER_PHASE_TIMEOUT_MS,
      // Host exchanges retain the command's own deadline and process-tree cleanup.
      onRequest: (value, context) => {
        if (
          !isRecord(value) ||
          value.type !== "git.batch" ||
          !isRecord(value.input) ||
          !Array.isArray(value.input.requests) ||
          value.input.requests.length === 0 ||
          value.input.requests.length > GIT_WORKER_HOST_BATCH_LIMIT
        ) {
          throw new Error("Invalid Git worker request batch");
        }
        const pending = Promise.all(
          value.input.requests.map((item) => request(item, context.signal)),
        ).then((replies): WorkerTaskResponse => ({
          input: replies.map((response) => response.input),
          transferList: [...new Set(replies.flatMap((response) => response.transferList ?? []))],
          timeoutMs: WORKER_PHASE_TIMEOUT_MS,
        }));
        hostWork.add(pending);
        void pending.then(
          () => hostWork.delete(pending),
          () => hostWork.delete(pending),
        );
        return pending;
      },
    });
    if (!reply.ok) {
      if (reply.error.origin !== undefined && hostErrors.has(reply.error.origin)) {
        throw hostErrors.get(reply.error.origin);
      }
      throw restoreGitWorkerFailure(reply.error);
    }
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    return reply.value;
  } finally {
    // A cancellation may terminate the worker before its host callback completes.
    await Promise.allSettled(hostWork);
    await Promise.all(
      [...temporaryDirectories].map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
  }
}
