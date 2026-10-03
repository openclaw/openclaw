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
import { withGitProcessOperation, type GitProcessOperation } from "../process/spawn-diagnostics.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { restoreGitWorkerFailure, serializeGitWorkerFailure } from "./git-worker-context.js";
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
import { ownedWorkerBytes } from "./worker-transfer-bytes.js";

type GitPool = WorkerTaskPool<GitWorkerCommand, GitWorkerReply<GitWorkerResult>>;
type GitWorkerRuntime = {
  reads?: GitPool;
  content?: GitPool;
  workspace?: GitPool;
  worktrees?: GitPool;
  worktreeMaintenance?: GitPool;
  pending: Set<Promise<unknown>>;
  closing?: Promise<void>;
};
const MAX_PENDING_OPERATIONS = 128;
const WORKER_PHASE_TIMEOUT_MS = 30 * 60_000;
const SPAWN_OPERATIONS = {
  "repository.identities": "repository.identities",
  "repository.branches": "repository.branches",
  "checkout.revision": "checkout.revision",
  "checkout.context": "checkout.context",
  "checkout.diff": "checkout.diff",
  "checkout.baseline": "checkout.baseline",
  "pull-request.branch-facts": "pull-request.branch-facts",
  "worktree.snapshot": "worktree.snapshot",
  "worktree.snapshot-verify-exact": "worktree.snapshot",
  "worktree.cleanup-inspection": "worktree.cleanup",
  "worktree.provisioning-inspection": "worktree.provision",
  "worktree.git-size": "worktree.inspect",
  "worktree.checkout-transition-size": "worktree.inspect",
  "worktree.directory-size": "worktree.inspect",
  "workspace.artifacts": "workspace.inventory",
  "workspace.inventory.select": "workspace.inventory",
  "workspace.inventory.existing": "workspace.inventory",
  "workspace.inventory.paths": "workspace.inventory",
  "workspace.inventory.staged-directories": "workspace.inventory",
  "workspace.manifest.capture": "workspace.manifest",
  "workspace.manifest.snapshot": "workspace.manifest",
  "workspace.manifest.parse": "workspace.manifest",
  "workspace.manifest.serialize": "workspace.manifest",
  "workspace.manifest.overlay": "workspace.manifest",
  "workspace.manifest.pair": "workspace.manifest",
  "workspace.manifest.staged": "workspace.manifest",
  "workspace.manifest.entries": "workspace.manifest",
  "workspace.manifest.file": "workspace.manifest",
  "workspace.manifest.nodes": "workspace.manifest",
  "workspace.manifest.stage-input": "workspace.manifest",
  "workspace.manifest.tree-input": "workspace.manifest",
  "workspace.manifest.remote-capture": "workspace.manifest",
  "workspace.reconcile.preflight": "workspace.manifest",
} satisfies Record<keyof GitWorkerOperations, GitProcessOperation>;

function runtime(): GitWorkerRuntime {
  return resolveGlobalSingleton<GitWorkerRuntime>(
    Symbol.for("openclaw.gitOperations"),
    () => ({ pending: new Set() }),
    (state) => {
      state.closing ??= (async () => {
        await Promise.all([
          state.reads?.close(),
          state.content?.close(),
          state.workspace?.close(),
          state.worktrees?.close(),
          state.worktreeMaintenance?.close(),
        ]);
        // Worker termination alone does not settle its parent-owned Git processes.
        await Promise.allSettled(state.pending);
        state.reads = undefined;
        state.content = undefined;
        state.workspace = undefined;
        state.worktrees = undefined;
        state.worktreeMaintenance = undefined;
      })().finally(() => {
        state.closing = undefined;
      });
      return state.closing;
    },
  );
}

function poolFor(state: GitWorkerRuntime, command: GitWorkerCommand): GitPool {
  const owner =
    command.type === "worktree.snapshot" || command.type === "worktree.cleanup-inspection"
      ? "worktreeMaintenance"
      : command.type.startsWith("worktree.")
        ? "worktrees"
        : command.type.startsWith("workspace.")
          ? "workspace"
          : command.type === "repository.branches" ||
              command.type === "repository.identities" ||
              command.type === "checkout.context" ||
              command.type === "checkout.revision"
            ? "reads"
            : "content";
  // Preparation can hold the allocation lease; unrelated maintenance must not block it.
  // Each worktree lane stays serial; host allocation and shared-ref guards still own writes.
  // Metadata likewise stays responsive while diffs or snapshots await slow Git work.
  return (state[owner] ??= new WorkerTaskPool({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.gitOperations),
    maxWorkers:
      owner === "content" || owner === "workspace"
        ? Math.max(1, Math.min(2, os.availableParallelism() - 1))
        : 1,
    sharedCompute: owner === "workspace",
    idleTimeoutMs: 30_000,
  }));
}

export type GitWorkerOperationOptions = {
  inputBytes?: number;
  /** Move task-owned inputs at admission and again when the worker receives them. */
  transferList?: (command: GitWorkerCommand) => readonly Transferable[];
  signal?: AbortSignal;
  assertCurrent?: () => void;
  /** Host-owned Git policy; the broker still owns authority and process settlement. */
  git?: {
    text: typeof runGitBytes;
    buffered: typeof runGitBuffered;
  };
  onInventoryChunk?: (bytes: Uint8Array, context: { signal: AbortSignal }) => Promise<void>;
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
  const transferList = options.transferList?.(command);
  const admitted = transferList
    ? structuredClone(command, { transfer: [...new Set(transferList)] })
    : structuredClone(command);
  const baseEnv = { ...process.env };
  // Pooled workers do not inherit later environment changes. Git discovery
  // overrides must disable direct metadata reads for this admission too.
  admitted.filesystemRefs =
    options.git === undefined &&
    !Object.entries(baseEnv).some(
      ([key, value]) =>
        value !== undefined &&
        /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|GIT_NAMESPACE|GIT_SHALLOW_FILE|GIT_GRAFT_FILE|GIT_REPLACE_REF_BASE|GIT_NO_REPLACE_OBJECTS|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES)$/i.test(
          key,
        ),
    );
  const operation = executeOperation(poolFor(state, admitted), admitted, baseEnv, {
    ...options,
    git: options.git ? { text: options.git.text, buffered: options.git.buffered } : undefined,
  });
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
      if (effect.type === "git.text" || effect.type === "git.buffer") {
        const run =
          effect.type === "git.text"
            ? (options.git?.text ?? runGitBytes)
            : (options.git?.buffered ?? runGitBuffered);
        // The parent owns the operation identity; worker batches cannot relabel their launches.
        const output = await withGitProcessOperation(SPAWN_OPERATIONS[command.type], () =>
          run(effect.input.cwd, effect.input.args, {
            ...effect.input.options,
            operation: SPAWN_OPERATIONS[command.type],
            baseEnv,
            signal,
            beforeRun: options.assertCurrent,
            killProcessTree: true,
          }),
        );
        const stdout = ownedWorkerBytes(output.stdout);
        const stderr = ownedWorkerBytes(output.stderr);
        result = { ...output, stdout, stderr };
        transferList.push(stdout.buffer, stderr.buffer);
      } else if (effect.type === "git.temporary-directory") {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-operation-"));
        temporaryDirectories.add(directory);
        result = directory;
      } else if (effect.type === "workspace.inventory.write") {
        if (!options.onInventoryChunk) {
          throw new Error("Workspace inventory has no active output owner");
        }
        options.assertCurrent?.();
        await options.onInventoryChunk(effect.input.bytes, { signal });
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
      inputBytes: options.inputBytes,
      transferList: options.transferList,
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
