import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Transferable } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  GitWorktreeEffect,
  GitWorktreeEffectResult,
} from "../agents/worktrees/git-worktree-operations.js";
import { runGitBytes, runGitBuffered } from "../agents/worktrees/git.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withGitProcessOperation, type GitProcessOperation } from "../process/spawn-diagnostics.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { withContentGitSlot } from "./git-content-budget.js";
import { startGitOperationTiming } from "./git-operation-timing.js";
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
const log = createSubsystemLogger("git/worker");
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
  "worktree.cleanup-fingerprint": "worktree.cleanup",
  "worktree.eviction-classify": "worktree.cleanup",
  "worktree.eviction-source": "worktree.cleanup",
  "worktree.eviction-repositories": "worktree.cleanup",
  "worktree.eviction-purge": "worktree.cleanup",
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

function poolFor(
  state: GitWorkerRuntime,
  command: GitWorkerCommand,
  contentRead: boolean,
): GitPool {
  const owner =
    command.type === "worktree.snapshot" ||
    command.type === "worktree.cleanup-inspection" ||
    command.type === "worktree.cleanup-fingerprint" ||
    command.type === "worktree.eviction-classify" ||
    command.type === "worktree.eviction-repositories" ||
    command.type === "worktree.eviction-purge"
      ? "worktreeMaintenance"
      : command.type.startsWith("worktree.")
        ? "worktrees"
        : command.type.startsWith("workspace.")
          ? "workspace"
          : contentRead
            ? "content"
            : "reads";
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
        (/^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|GIT_NAMESPACE|GIT_SHALLOW_FILE|GIT_GRAFT_FILE|GIT_REPLACE_REF_BASE|GIT_NO_REPLACE_OBJECTS|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG_PARAMETERS)$/i.test(
          key,
        ) ||
          (/^(HOME|XDG_CONFIG_HOME|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM)$/i.test(key) &&
            /[\r\n]/u.test(value))),
    )
      ? createHash("sha256")
          .update(
            JSON.stringify(
              Object.entries(baseEnv).filter(([key]) =>
                /^(GIT_|HOME$|XDG_CONFIG_HOME$|PATH$|SUDO_UID$)/i.test(key),
              ),
            ),
          )
          .digest("hex")
      : undefined;
  const operation = executeOperation(state, admitted, baseEnv, {
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
  state: GitWorkerRuntime,
  command: GitWorkerCommand,
  baseEnv: NodeJS.ProcessEnv,
  options: GitWorkerOperationOptions,
): Promise<GitWorkerResult> {
  const contentRoot =
    command.type === "checkout.diff" || command.type === "checkout.baseline"
      ? command.input.cwd
      : command.type === "pull-request.branch-facts"
        ? command.input.root
        : undefined;
  const contentRead = contentRoot !== undefined;
  const contentGit =
    contentRead ||
    command.type === "worktree.snapshot" ||
    command.type === "worktree.snapshot-verify-exact";
  let gitCommandCount = 0;
  let summedGitWallMs = 0;
  let summedGitQueueWaitMs = 0;
  let gitStdoutBytes = 0;
  let gitStderrBytes = 0;
  let gitTimeoutCount = 0;
  let workerQueueWaitMs: number | null = null;
  let slowestGitCommand:
    | { command: string; diffMode?: string; durationMs: number; termination: string }
    | undefined;
  const timing =
    contentRoot !== undefined
      ? startGitOperationTiming("content-read", log, () => ({
          operation: command.type,
          checkoutId: createHash("sha256")
            .update(path.resolve(contentRoot))
            .digest("hex")
            .slice(0, 16),
          checkoutClass:
            command.type === "pull-request.branch-facts" && command.input.refreshIndex
              ? "managed"
              : "unspecified",
          gitCommandCount,
          workerQueueWaitMs,
          summedGitWallMs: Math.round(summedGitWallMs),
          summedGitQueueWaitMs: Math.round(summedGitQueueWaitMs),
          gitStdoutBytes,
          gitStderrBytes,
          gitTimeoutCount,
          slowestGitCommand,
        }))
      : undefined;
  let firstHostRequest = true;
  let outcome: "returned" | "threw" = "threw";
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
        const queuedAt = timing ? performance.now() : 0;
        const execute = async () => {
          const startedAt = timing ? performance.now() : 0;
          let termination = "threw";
          if (timing) {
            gitCommandCount++;
            summedGitQueueWaitMs += startedAt - queuedAt;
          }
          try {
            const output = await withGitProcessOperation(SPAWN_OPERATIONS[command.type], () =>
              run(effect.input.cwd, effect.input.args, {
                ...effect.input.options,
                operation: SPAWN_OPERATIONS[command.type],
                baseEnv,
                signal,
                beforeRun: options.assertCurrent,
                killProcessTree: true,
                lowerPriority: contentGit,
              }),
            );
            if (timing) {
              termination = output.termination;
              gitStdoutBytes += output.stdout.byteLength;
              gitStderrBytes += output.stderr.byteLength;
              gitTimeoutCount += Number(termination === "timeout");
            }
            return output;
          } finally {
            if (timing) {
              const durationMs = Math.round(performance.now() - startedAt);
              summedGitWallMs += durationMs;
              if (!slowestGitCommand || durationMs > slowestGitCommand.durationMs) {
                const args = effect.input.args;
                let i = 0;
                while (i < args.length && args[i]!.startsWith("-")) {
                  i += args[i] === "-c" || args[i] === "-C" ? 2 : 1;
                }
                const name = args[i] ?? "";
                slowestGitCommand = {
                  // Only fixed command names may escape; never paths, refs, config, or stderr.
                  command:
                    /^(diff|ls-files|rev-parse|rev-list|merge-base|cat-file|symbolic-ref|for-each-ref|version|log|show|hash-object)$/.test(
                      name,
                    )
                      ? name
                      : "other",
                  ...(name === "diff"
                    ? {
                        diffMode: args.includes("--no-index")
                          ? "--no-index"
                          : (args
                              .slice(i + 1)
                              .find((arg) =>
                                /^(--shortstat|--raw|--patch|--name-status)$/.test(arg),
                              ) ?? "other"),
                      }
                    : {}),
                  durationMs,
                  termination,
                };
              }
            }
          }
        };
        const output = await (contentGit ? withContentGitSlot(execute, signal) : execute());
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
    const enqueuedAt = timing ? performance.now() : 0;
    const input = timing
      ? () => {
          workerQueueWaitMs = Math.round(performance.now() - enqueuedAt);
          return command;
        }
      : command;
    const reply = await poolFor(state, command, contentRead).run(input, {
      inputBytes: options.inputBytes,
      transferList: options.transferList,
      signal: options.signal,
      timeoutMs: WORKER_PHASE_TIMEOUT_MS,
      // Host exchanges retain the command's own deadline and process-tree cleanup.
      onRequest: (value, context) => {
        if (firstHostRequest) {
          firstHostRequest = false;
          timing?.markPhase();
        }
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
    timing?.markPhase();
    if (!reply.ok) {
      if (reply.error.origin !== undefined && hostErrors.has(reply.error.origin)) {
        throw hostErrors.get(reply.error.origin);
      }
      throw restoreGitWorkerFailure(reply.error);
    }
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    outcome = "returned";
    return reply.value;
  } finally {
    let cleanupSucceeded = false;
    try {
      // A cancellation may terminate the worker before its host callback completes.
      await Promise.allSettled(hostWork);
      await Promise.all(
        [...temporaryDirectories].map((directory) =>
          fs.rm(directory, { recursive: true, force: true }),
        ),
      );
      cleanupSucceeded = true;
    } finally {
      timing?.finish(cleanupSucceeded ? outcome : "threw");
    }
  }
}
