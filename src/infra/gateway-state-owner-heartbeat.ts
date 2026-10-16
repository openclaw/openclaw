import fs from "node:fs";
import { MessageChannel, receiveMessageOnPort, type Worker } from "node:worker_threads";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { requestCliParentTermination } from "../../cli-parent-lifetime.mjs";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { GATEWAY_OWNER_HEARTBEAT_MS } from "./gateway-lock-payload.js";
import {
  type GatewayStateOwnerHeartbeatData,
  renewGatewayStateOwnerLock,
} from "./gateway-state-owner-heartbeat.runtime.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import { createCpuTrackedWorker } from "./worker-cpu.js";
import { recordWorkerMessage } from "./worker-message-metrics.js";

const now = Date.now.bind(Date);

/** Process and schema owners share one renewal worker and one failure deadline. */
export function startGatewayStateOwnerHeartbeat(
  heldLocks: ReadonlySet<{ lockPath: string; verifyStillHeld(): boolean }>,
  onLost: (error: Error) => void,
) {
  const locks: Record<string, string> = {};
  for (const lock of heldLocks) {
    locks[lock.lockPath] = fs.readFileSync(lock.lockPath, "utf8");
    if (!lock.verifyStillHeld()) {
      throw new Error("OpenClaw state ownership is no longer current");
    }
  }
  const rootPath = Object.keys(locks)[0];
  if (!rootPath) {
    throw new Error("Gateway state ownership requires a held lock");
  }
  const rootIdentity = fs.statSync(rootPath, { bigint: true });
  const { moduleUrl: url, runtimeGeneration } = captureRuntimeWorkerSource(
    resolveRuntimeProcessEntrypointUrl("gatewayStateOwnerHeartbeat"),
  );
  return runInDetachedAsyncContext(() => {
    const lastBeat = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
    // Match the lock's mtime clock; Bun workers have independent hrtime origins.
    Atomics.store(lastBeat, 0, BigInt(now()));
    let worker!: Worker;
    let port1!: MessageChannel["port1"];
    // A custody event is the worker's own proof verdict (lock replaced, renewal
    // failed): custody is gone and only a fence is honest. A worker crash or clean
    // exit without such an event says nothing about custody, so the synchronous
    // inode/content proof below decides whether the renewal loop may respawn.
    let custodyEvent: string | null = null;
    let workerFault: string | null = null;
    let workerExited = false;
    let stopped = false;
    // Late events from a replaced worker must not corrupt the respawned state.
    let spawnGeneration = 0;
    const spawn = () => {
      const generation = ++spawnGeneration;
      const { port1: readPort, port2 } = new MessageChannel();
      port1 = readPort;
      port1.unref();
      worker = createCpuTrackedWorker(url, {
        workerData: {
          // Fresh copy: projection locks added since the last spawn must be
          // renewed by a respawned worker too, not just the acquisition set.
          clock: "epoch",
          locks: { ...locks },
          intervalMs: GATEWAY_OWNER_HEARTBEAT_MS,
          failureMs: 60_000,
          lastBeat: lastBeat.buffer,
          events: port2,
        } satisfies GatewayStateOwnerHeartbeatData,
        transferList: [port2],
        execArgv: resolveRuntimeWorkerThreadExecArgv(url),
      });
      worker.unref();
      workerExited = false;
      workerFault = null;
      // Parent expiration checks verify physical custody directly. The callback
      // keeps launcher-loss termination prompt between synchronous drains.
      port1.on("message", (message) => {
        recordWorkerMessage("lifecycle", "from_worker");
        if (generation !== spawnGeneration || stopped) {
          return;
        }
        if (message === "parent-lost") {
          requestCliParentTermination();
        } else if (typeof message === "string") {
          custodyEvent ??= message;
        }
      });
      worker.on("error", (error) => {
        if (generation === spawnGeneration && !stopped) {
          workerFault = coerceErrorMessage(error);
        }
      });
      worker.on("exit", () => {
        if (generation === spawnGeneration && !stopped) {
          workerExited = true;
        }
      });
    };
    spawn();
    const inspect = () => {
      // Drain diagnostics synchronously when native work resumes before port callbacks.
      let message;
      while ((message = receiveMessageOnPort(port1))) {
        recordWorkerMessage("lifecycle", "from_worker");
        if (typeof message.message === "string") {
          custodyEvent = message.message;
          if (message.message === "parent-lost") {
            requestCliParentTermination();
          }
        }
      }
      let age = now() - Number(Atomics.load(lastBeat, 0));
      // A negative age is a wall-clock step backwards (for example an NTP
      // correction after resume). Treat it as overdue so the synchronous path
      // re-baselines from a verified touch instead of fencing on the step alone.
      if (age >= 60_000 || age < 0) {
        try {
          const renewalStartedAt = now();
          const stamp = new Date(renewalStartedAt);
          for (const lock of heldLocks) {
            if (!lock.verifyStillHeld()) {
              if (lock.lockPath !== rootPath) {
                continue;
              }
              throw new Error("owner lock was removed or replaced");
            }
            const fd = fs.openSync(lock.lockPath, "r+");
            try {
              const held = fs.fstatSync(fd, { bigint: true });
              if (
                lock.lockPath === rootPath &&
                (held.dev !== rootIdentity.dev || held.ino !== rootIdentity.ino)
              ) {
                throw new Error("owner lock was removed or replaced");
              }
              const raw = fs.readFileSync(fd, "utf8");
              if (
                !lock.verifyStillHeld() ||
                !renewGatewayStateOwnerLock(fd, lock.lockPath, raw, stamp)
              ) {
                throw new Error("owner lock was removed or replaced");
              }
            } finally {
              fs.closeSync(fd);
            }
          }
          Atomics.store(lastBeat, 0, BigInt(renewalStartedAt));
          age = 0;
          if (workerExited) {
            // Custody survived; only the renewal loop died. Respawn it instead of
            // degrading to main-thread renewals forever — a silent worker exit
            // (observed after sleep/wake) must not leave a zombie Gateway.
            spawn();
          }
        } catch (error) {
          // Keep the most specific reason: the worker's custody verdict, then its
          // crash message, then the synchronous proof failure. A dead worker must
          // not masquerade as a renewal timeout.
          const reason = custodyEvent ?? workerFault ?? coerceErrorMessage(error);
          onLost(
            new Error(
              `Gateway state ownership is no longer current at ${rootPath}: ${reason}; restart the Gateway.`,
            ),
          );
        }
      }
      const remaining = age < 0 ? 0 : 60_000 - age;
      return remaining;
    };
    let timer: ReturnType<typeof setTimeout>;
    const watch = () => {
      const remaining = inspect();
      if (remaining > 0 && !stopped) {
        timer = setTimeout(watch, remaining);
        timer.unref();
      }
    };
    watch();
    let termination: Promise<number> | undefined;
    const stop = () => {
      if (termination) {
        return;
      }
      stopped = true;
      clearTimeout(timer);
      port1.close();
      worker.postMessage("stop", []);
      termination ??= worker.terminate();
    };
    runtimeGeneration?.retain(worker, async () => async () => {
      stop();
      await termination;
    });
    const paths = new Set(Object.keys(locks));
    return {
      // Getter: respawn replaces the worker, and callers must reach the live one.
      get worker() {
        return worker;
      },
      paths,
      inspect,
      addLock(lockPath: string, raw: string) {
        // Record on this side too so a later respawn renews and proves it.
        locks[lockPath] = raw;
        paths.add(lockPath);
        worker.postMessage([lockPath, raw], []);
      },
      stop,
    };
  });
}
