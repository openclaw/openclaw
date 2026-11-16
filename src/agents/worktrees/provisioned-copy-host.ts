import { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import {
  prepareSessionSourceEffect,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type {
  FsSafeCopyReply,
  FsSafeProvisionCopy,
  FsSafeProvisionCopyInput,
} from "../../infra/fs-safe-copy-worker-contract.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createWorkerMutationAuthority } from "../../infra/worker-mutation-authority.js";
import { WorkerTaskError, WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { installWorkspaceFilesystemEvidence } from "../workspace-state-guard.js";
import {
  recordWorktreePreparationFailure,
  setWorktreePreparationCopyDetails,
  startWorktreePreparationPhase,
} from "./preparation-timing.js";
import type { WorktreeWorkerAuthority } from "./types.js";

type Runtime = {
  pool?: WorkerTaskPool<FsSafeProvisionCopy, FsSafeCopyReply>;
  closing?: Promise<void>;
};

type CopyOptions = {
  signal?: AbortSignal;
  assertCurrent?: SessionSourceAssertion;
  workerAuthority?: WorktreeWorkerAuthority;
};

export function copyProvisionedPathsInWorker(
  source: string,
  destination: string,
  paths: readonly string[],
  options: CopyOptions,
): Promise<string[]> {
  return runCopyInWorker({ type: "provision", source, destination, paths }, options);
}

export async function cloneRefsTreeInWorker(
  source: string,
  destination: string,
  options: import("./filesystem-backend.types.js").WorktreeFilesystemOptions,
): Promise<void> {
  await runCopyInWorker(
    { type: "refs-copy", source, destination, paths: [], nativeMode: getFsSafeNativeConfig().mode },
    { ...options, assertCurrent: options.commitGuard },
  );
}

async function runCopyInWorker(
  command: FsSafeProvisionCopyInput,
  options: CopyOptions,
): Promise<string[]> {
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    if (prepared) {
      prepared.assertCurrent();
    } else {
      options.assertCurrent?.();
    }
    options.signal?.throwIfAborted();
  };
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
  const prepared = options.assertCurrent
    ? await prepareSessionSourceEffect(options.assertCurrent)
    : undefined;
  await using _ = { [Symbol.asyncDispose]: async () => await prepared?.release?.() };
  const workspaceEvidence = [
    ...new Set([
      ...(options.workerAuthority?.workspaceEvidence ?? []),
      ...(prepared?.workspaceEvidence ?? []),
    ]),
  ];
  const runtime = resolveGlobalSingleton<Runtime>(
    Symbol.for("openclaw.worktreeProvisionCopies"),
    () => ({}),
    (owned) => {
      owned.closing ??= (owned.pool?.close() ?? Promise.resolve()).then(() => {
        owned.pool = undefined;
        owned.closing = undefined;
      });
      return owned.closing;
    },
  );
  if (runtime.closing) {
    throw new WorkerTaskError(
      "Worktree provisioning is closing; retry the operation",
      "unavailable",
    );
  }
  const pool = (runtime.pool ??= new WorkerTaskPool<FsSafeProvisionCopy, FsSafeCopyReply>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.fsSafeCopy),
    // Copy custody must not occupy the shared Git/compute admission queue.
    maxWorkers: 2,
    idleTimeoutMs: 30_000,
  }));
  const authority = createWorkerMutationAuthority(assertCurrent, options.signal);
  // Until the first mutation request, time includes pool admission, worker startup,
  // and filesystem preflight. Do not report it as time spent copying file bytes.
  const finishWait = startWorktreePreparationPhase("provisionCopyWait");
  let finishCopy: (() => void) | undefined;
  try {
    const reply = await pool.run(
      {
        ...command,
        decision: authority.buffer,
        workspaceEvidence,
        stateOwnerPath: options.workerAuthority?.stateOwnerPath,
      },
      {
        signal: options.signal,
        inputBytes: command.paths.reduce(
          (bytes, pathname) => bytes + Buffer.byteLength(pathname),
          0,
        ),
        onNotification: () => {
          if (authority.onNotification() && !finishCopy) {
            finishWait();
            finishCopy = startWorktreePreparationPhase("provisionCopy");
          }
        },
      },
    );
    if ("copyDetails" in reply && reply.copyDetails) {
      setWorktreePreparationCopyDetails(reply.copyDetails);
    }
    authority.throwIfRefused();
    assertCurrent();
    if (reply.type === "failed") {
      throw Object.assign(new Error(reply.message), { code: reply.code });
    }
    if (
      (command.type === "provision" && reply.type !== "provisioned") ||
      (command.type === "refs-copy" && reply.type !== "written")
    ) {
      throw new Error("Worktree provisioning returned no completion receipt");
    }
    if (
      workspaceEvidence &&
      (reply.type === "written" || reply.type === "provisioned") &&
      reply.workspaceEvidence
    ) {
      installWorkspaceFilesystemEvidence(workspaceEvidence, reply.workspaceEvidence);
    }
    return reply.type === "provisioned" ? reply.paths : [];
  } catch (error) {
    let cause = error;
    try {
      authority.throwIfRefused();
    } catch (refused) {
      cause = refused;
    }
    recordWorktreePreparationFailure(finishCopy ? "provisionCopy" : "provisionCopyWait", cause);
    throw cause;
  } finally {
    finishWait();
    finishCopy?.();
    authority.dispose();
  }
}
