import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { enableConsoleCapture, routeLogsToStderr } from "../logging/console.js";
import { signalProcessTree } from "../process/kill-tree.js";
import {
  bindInheritedNativeProcessOwner,
  bindInheritedProcessLineageFds,
} from "../process/supervisor/inherited-process-lineage.js";
import { isOwnedProcessGroupGone } from "../process/supervisor/service-child-group-ownership.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { WorkerBrowserRuntime } from "./browser-runtime.js";
import {
  NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
  type NodeWorkerConnectionFailureMessage,
} from "./node-supervisor-protocol.js";
import { hasExactOwnKeys } from "./protocol-record.js";
import { runWorkerCommand, type WorkerCommandLifetime } from "./worker-command.runtime.js";

const WORKER_START_MESSAGE_TYPE = "openclaw-worker-start-v1";

function parseWorkerStartMessage(
  value: unknown,
): { lineageFds?: readonly number[]; nativeProcessOwner?: string } | undefined {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, ["type"], ["lineageFds", "nativeProcessOwner"]) ||
    value.type !== WORKER_START_MESSAGE_TYPE
  ) {
    return undefined;
  }
  const nativeProcessOwner = value.nativeProcessOwner;
  if (nativeProcessOwner !== undefined) {
    if (typeof nativeProcessOwner !== "string") {
      return undefined;
    }
    try {
      const url = new URL(nativeProcessOwner);
      if (url.protocol !== "file:" || url.host || url.search || url.hash) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  if (!Object.hasOwn(value, "lineageFds")) {
    return nativeProcessOwner === undefined ? {} : undefined;
  }
  const fds = value.lineageFds;
  if (
    !Array.isArray(fds) ||
    fds.length === 0 ||
    !fds.every(
      (fd: unknown): fd is number => typeof fd === "number" && Number.isSafeInteger(fd) && fd >= 3,
    ) ||
    new Set(fds).size !== fds.length
  ) {
    return undefined;
  }
  return { lineageFds: fds, ...(nativeProcessOwner === undefined ? {} : { nativeProcessOwner }) };
}

function createWorkerIpcLifetime(): WorkerCommandLifetime {
  if (!process.connected || !process.channel || typeof process.send !== "function") {
    throw new Error("internal worker IPC mode requires a connected Node IPC channel");
  }
  const abortController = new AbortController();
  let disposed = false;
  let started = false;
  let settled = false;
  let releaseLineage: (() => void) | undefined;
  let releaseNativeOwner: (() => void) | undefined;
  const startResult = createDeferredCore<boolean>();
  const rejectOrAbort = (error: Error) => {
    if (!settled) {
      settled = true;
      startResult.reject(error);
      return;
    }
    abortController.abort(error);
  };
  const onMessage = (message: unknown) => {
    if (disposed) {
      return;
    }
    const start = parseWorkerStartMessage(message);
    if (!start || settled) {
      rejectOrAbort(new Error("invalid internal worker IPC start message"));
      return;
    }
    if (start.lineageFds) {
      releaseLineage = bindInheritedProcessLineageFds(start.lineageFds);
    }
    if (start.nativeProcessOwner) {
      releaseNativeOwner = bindInheritedNativeProcessOwner(start.nativeProcessOwner);
    }
    started = true;
    settled = true;
    startResult.resolve(true);
  };
  const onDisconnect = () => {
    if (disposed) {
      return;
    }
    if (!settled) {
      settled = true;
      startResult.resolve(false);
      return;
    }
    if (started) {
      abortController.abort(new Error("worker supervisor lifetime ended"));
    }
  };
  process.on("message", onMessage);
  process.once("disconnect", onDisconnect);
  return {
    started: startResult.promise,
    signal: abortController.signal,
    reportConnectionFailure: (cause) => {
      if (disposed || !process.connected || typeof process.send !== "function") {
        return;
      }
      const message: NodeWorkerConnectionFailureMessage = {
        type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
        cause: cause ?? null,
      };
      try {
        process.send(message, () => {});
      } catch {
        // The disconnect handler owns worker shutdown when the supervisor is gone.
      }
    },
    terminateOwnedTree: () => {
      // Anchored applications share their owner's group; direct workers may lead their own.
      if (process.platform !== "darwin") {
        // Linux reads its group from procfs and keeps PID signaling where group signals are denied.
        signalProcessTree(process.pid, "SIGKILL");
        return;
      }
      // Exec relays start parent-loss cleanup only after this process dies, so decide by
      // syscall: Darwin's ps census can stall past their cleanup budget.
      process.kill(isOwnedProcessGroupGone(process.pid) ? process.pid : -process.pid, "SIGKILL");
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      releaseLineage?.();
      releaseNativeOwner?.();
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      if (process.connected) {
        try {
          process.disconnect?.();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ERR_IPC_DISCONNECTED") {
            throw error;
          }
        }
      }
    },
  };
}

/** Runs the worker-only process entry without loading the general CLI command tree. */
export async function runWorkerProcess(
  options: {
    internalWorkerIpc?: boolean;
    managed?: boolean;
    browserRuntime?: WorkerBrowserRuntime;
  } = {},
): Promise<void> {
  const { initializeSqliteRuntimeCapabilities } = await import("../infra/bun-sqlite-library.js");
  await initializeSqliteRuntimeCapabilities();
  // Stdout belongs to the worker result; diagnostics stay on stderr through process shutdown.
  routeLogsToStderr();
  enableConsoleCapture();
  await runWorkerCommand({
    input: process.stdin,
    output: process.stdout,
    ...(options.managed ? { managed: true } : {}),
    ...(options.internalWorkerIpc ? { lifetime: createWorkerIpcLifetime() } : {}),
    ...(options.browserRuntime ? { browserRuntime: options.browserRuntime } : {}),
  });
}
