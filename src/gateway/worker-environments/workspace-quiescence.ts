import { randomBytes } from "node:crypto";
import path from "node:path";
import type { SpawnResult } from "../../process/exec.js";
import {
  NODE_WORKSPACE_QUIESCENCE_COMMAND,
  type NodeWorkerWorkspaceQuiescenceInput,
} from "../../worker/node-workspace-protocol.js";
import type { WorkerWorkspaceCommand, WorkerWorkspaceQuiescence } from "./tunnel-contract.js";
import { workspaceQuiescenceArgv } from "./workspace-quiescence-scripts.js";
import {
  waitForQuiescenceRenewal,
  workerWorkspaceCommandSucceeded,
  workspaceSyncError,
} from "./workspace-sync-helpers.js";

const WORKSPACE_QUIESCENCE_TIMEOUT_MS = 12 * 60_000;
const WORKSPACE_QUIESCENCE_RENEW_INTERVAL_MS = 4 * 60_000;

export function createWorkerWorkspaceQuiescence(params: {
  ownerSignal: AbortSignal;
  sharedHost: boolean;
  nativeWatchdog?: () => Promise<boolean>;
  runWorkspaceCommand: (command: WorkerWorkspaceCommand) => Promise<SpawnResult>;
}): (remoteWorkspaceDir: string) => Promise<WorkerWorkspaceQuiescence> {
  return async (remoteWorkspaceDir) => {
    const posixAbsolute = path.posix.isAbsolute(remoteWorkspaceDir);
    const windowsAbsolute = path.win32.isAbsolute(remoteWorkspaceDir);
    if (!posixAbsolute && !windowsAbsolute) {
      throw new Error("Worker workspace quiescence path must be absolute");
    }
    if (!posixAbsolute && windowsAbsolute && !params.sharedHost) {
      throw new Error("Windows worker workspace quiescence requires a shared host");
    }
    const hostMode = params.sharedHost ? "shared-host" : "dedicated";
    // Pin one dialect for the lease; a reconnect must not reinterpret its nonce/custody.
    const nativeWatchdog = (await params.nativeWatchdog?.()) ?? false;
    params.ownerSignal.throwIfAborted();
    const nativeNonce = randomBytes(16).toString("hex");
    const run = async (operation: NodeWorkerWorkspaceQuiescenceInput) => {
      const result = await params.runWorkspaceCommand({
        transportRetry: "never",
        argv: nativeWatchdog
          ? [NODE_WORKSPACE_QUIESCENCE_COMMAND, remoteWorkspaceDir]
          : workspaceQuiescenceArgv(remoteWorkspaceDir, operation, hostMode),
        ...(nativeWatchdog ? { quiescence: operation } : { legacyQuiescence: true }),
      });
      if (!workerWorkspaceCommandSucceeded(result)) {
        throw workspaceSyncError(result);
      }
      return result;
    };
    let nonce: string;
    try {
      const result = await run({
        action: "acquire",
        nonce: nativeNonce,
        timeoutMs: WORKSPACE_QUIESCENCE_TIMEOUT_MS,
      });
      const acknowledgement = /^quiesced ([a-f0-9]{32})$/u.exec(result.stdout.trim());
      if (!acknowledgement || (nativeWatchdog && acknowledgement[1] !== nativeNonce)) {
        throw new Error("Worker workspace quiescence returned an invalid acknowledgement");
      }
      nonce = acknowledgement[1]!;
    } catch (error) {
      if (nativeWatchdog && !params.ownerSignal.aborted) {
        try {
          // No lease handle was delivered. Join host recovery (or retire a lost
          // acknowledgement) and unpin the dialect only through a real release.
          await run({ action: "release", nonce: nativeNonce });
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            "Worker workspace quiescence acquisition failed and recovery did not complete",
            { cause: recoveryError },
          );
        }
      }
      throw error;
    }
    let releasePromise: Promise<void> | undefined;
    let renewalFailure: unknown;
    const renewalAbort = new AbortController();
    const renewalSignal = AbortSignal.any([params.ownerSignal, renewalAbort.signal]);
    let renewalQueue = Promise.resolve();
    const renew = (validationMode: "heartbeat" | "final") => {
      const operation = renewalQueue.then(async () => {
        const renewedResult = await run({
          action: "renew",
          nonce,
          timeoutMs: WORKSPACE_QUIESCENCE_TIMEOUT_MS,
          validationMode,
        });
        if (renewedResult.stdout.trim() !== `renewed ${nonce}`) {
          throw new Error(
            "Worker workspace quiescence renewal returned an invalid acknowledgement",
          );
        }
      });
      renewalQueue = operation.catch(() => undefined);
      return operation;
    };
    const renewalLoop = (async () => {
      while (!renewalSignal.aborted) {
        if (
          !(await waitForQuiescenceRenewal(renewalSignal, WORKSPACE_QUIESCENCE_RENEW_INTERVAL_MS))
        ) {
          return;
        }
        try {
          await renew("heartbeat");
        } catch (error) {
          renewalFailure = error;
          return;
        }
      }
    })();
    return {
      assertActive: async () => {
        if (renewalSignal.aborted) {
          throw new Error("Worker workspace quiescence was already released");
        }
        if (renewalFailure) {
          throw new Error("Worker workspace quiescence renewal failed", {
            cause: renewalFailure,
          });
        }
        await renew("final");
      },
      resume: async () => {
        releasePromise ??= (async () => {
          renewalAbort.abort();
          await renewalLoop;
          await renewalQueue;
          // Teardown can retain an attached row after fencing the tunnel. Recheck after
          // draining renewals: a closed owner releases only local state, never remote work.
          if (!params.ownerSignal.aborted) {
            await run({ action: "release", nonce });
          }
        })().catch((error: unknown) => {
          if (params.ownerSignal.aborted) {
            return;
          }
          releasePromise = undefined;
          throw error;
        });
        await releasePromise;
      },
    };
  };
}
