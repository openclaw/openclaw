import { AsyncLocalStorage } from "node:async_hooks";
import { isMarkedAsUntransferable, type Transferable } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { WorktreeRepositoryError } from "../agents/worktrees/errors.js";
import {
  GIT_WORKER_HOST_BATCH_LIMIT,
  type GitWorkerEffect,
  type GitWorkerEffects,
  type GitWorkerFailure,
  type GitWorkerGitCommand,
  type GitWorkerGitCommands,
  type GitWorkerHostBatch,
  type GitWorkerHostRequest,
  type GitWorkerReply,
} from "./git-worker-contract.js";
import type { WorkerTaskChannel } from "./worker-task-pool.js";

type PendingHostRequest = {
  request: GitWorkerHostRequest;
  transfers: Transferable[];
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};
type GitWorkerContext = {
  channel: WorkerTaskChannel;
  pending: PendingHostRequest[];
  drain?: Promise<void>;
  closed: boolean;
};
const context = new AsyncLocalStorage<GitWorkerContext>();
const errorOrigins = new WeakMap<Error, number>();

export function serializeGitWorkerFailure(error: unknown): GitWorkerFailure {
  const record = asOptionalRecord(error);
  const code = record?.code;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(error instanceof Error && errorOrigins.has(error)
      ? { origin: errorOrigins.get(error) }
      : {}),
  };
}

export function restoreGitWorkerFailure(failure: GitWorkerFailure): Error {
  const error =
    failure.name === "WorktreeRepositoryError"
      ? new WorktreeRepositoryError(failure.message)
      : new Error(failure.message);
  error.name = failure.name;
  if (failure.code !== undefined) {
    Object.assign(error, { code: failure.code });
  }
  if (failure.origin !== undefined) {
    errorOrigins.set(error, failure.origin);
  }
  return error;
}

/** Only uniquely owned buffers can be transferred; pooled Buffers share unrelated bytes. */
export function ownedGitWorkerBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    !isMarkedAsUntransferable(bytes.buffer)
  ) {
    return new Uint8Array(bytes.buffer);
  }
  return Uint8Array.from(bytes);
}

export function hasGitWorkerContext(): boolean {
  return context.getStore() !== undefined;
}

export async function withGitWorkerContext<T>(
  channel: WorkerTaskChannel,
  operation: () => Promise<T>,
): Promise<T> {
  const state: GitWorkerContext = { channel, pending: [], closed: false };
  return await context.run(state, async () => {
    try {
      return await operation();
    } finally {
      state.closed = true;
      await state.drain;
    }
  });
}

async function requestHost(request: GitWorkerHostRequest): Promise<unknown> {
  const state = context.getStore();
  if (!state || state.closed) {
    throw new Error("Git operation requires its worker host");
  }
  const transfers: Transferable[] = [];
  if (
    (request.type === "git.text" || request.type === "git.buffer") &&
    request.input.options.input instanceof Uint8Array
  ) {
    // The Git caller may reuse stdin after the command. Copy on the worker,
    // then move this operation-owned transport buffer without detaching caller data.
    const input = Uint8Array.from(request.input.options.input);
    request.input.options.input = input;
    transfers.push(input.buffer);
  }
  return await new Promise((resolve, reject) => {
    state.pending.push({ request, transfers, resolve, reject });
    state.drain ??= Promise.resolve().then(() => drainHostRequests(state));
  });
}

/** Independent Git reads keep their parallelism inside the pool's serial host channel. */
async function drainHostRequests(state: GitWorkerContext): Promise<void> {
  try {
    while (state.pending.length > 0) {
      const pending = state.pending.splice(0, GIT_WORKER_HOST_BATCH_LIMIT);
      try {
        if (state.closed) {
          throw new Error("Git operation closed before host execution");
        }
        const batch: GitWorkerHostBatch = {
          type: "git.batch",
          input: { requests: pending.map((entry) => entry.request) },
        };
        const response = await state.channel.request(
          batch,
          pending.flatMap((entry) => entry.transfers),
        );
        try {
          // SAFETY: The private host returns one result per typed request in the same order.
          const replies = response.input as GitWorkerReply<unknown>[];
          if (!Array.isArray(replies) || replies.length !== pending.length) {
            throw new Error("Git host returned an incomplete batch");
          }
          for (const [index, entry] of pending.entries()) {
            const reply = replies[index]!;
            if (reply.ok) {
              entry.resolve(reply.value);
            } else {
              entry.reject(restoreGitWorkerFailure(reply.error));
            }
          }
        } finally {
          response.consumed();
        }
      } catch (error) {
        for (const entry of pending) {
          entry.reject(error);
        }
      }
    }
  } finally {
    state.drain = undefined;
  }
}

export async function requestGitWorkerCommand<K extends keyof GitWorkerGitCommands>(
  command: Extract<GitWorkerGitCommand, { type: K }>,
): Promise<GitWorkerGitCommands[K]["output"]> {
  // SAFETY: The command discriminant binds this private host response to its declared output.
  return (await requestHost(command)) as GitWorkerGitCommands[K]["output"];
}

export async function requestGitWorkerEffect<K extends keyof GitWorkerEffects>(
  effect: Extract<GitWorkerEffect, { type: K }>,
): Promise<GitWorkerEffects[K]["output"]> {
  // SAFETY: The effect discriminant binds this private host response to its declared output.
  return (await requestHost(effect)) as GitWorkerEffects[K]["output"];
}
