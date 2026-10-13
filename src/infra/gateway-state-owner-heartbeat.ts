import fs from "node:fs";
import { MessageChannel } from "node:worker_threads";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { GATEWAY_OWNER_HEARTBEAT_MS } from "./gateway-lock-payload.js";
import {
  type GatewayStateOwnerHeartbeatData,
  renewGatewayStateOwnerLock,
} from "./gateway-state-owner-heartbeat.runtime.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "./runtime-worker-url.js";
import { createCpuTrackedWorker } from "./worker-cpu.js";

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
    resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.gatewayStateOwnerHeartbeat),
  );
  return runInDetachedAsyncContext(() => {
    const lastBeat = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
    // Match the lock's mtime clock; Bun workers have independent hrtime origins.
    Atomics.store(lastBeat, 0, BigInt(now()));
    const { port1, port2 } = new MessageChannel();
    const worker = createCpuTrackedWorker(url, {
      workerData: {
        clock: "epoch",
        locks,
        intervalMs: GATEWAY_OWNER_HEARTBEAT_MS,
        failureMs: 60_000,
        lastBeat: lastBeat.buffer,
        events: port2,
      } satisfies GatewayStateOwnerHeartbeatData,
      transferList: [port2],
      execArgv: resolveRuntimeWorkerThreadExecArgv(url),
    });
    worker.unref();
    // Parent expiration checks verify physical custody directly.
    port1.on("message", () => undefined);
    port1.unref();
    worker.on("error", (err) => onLost(new Error(`${coerceErrorMessage(err)}; restart Gateway.`)));
    const inspect = () => {
      const renewedAt = Atomics.load(lastBeat, 0);
      const age = now() - Number(renewedAt);
      const remaining = age < 0 ? 0 : 60_000 - age;
      if (remaining <= 0) {
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
          return 60_000;
        } catch (error) {
          onLost(
            new Error(
              `Gateway state ownership is no longer current at ${rootPath}: ${coerceErrorMessage(error)}; restart the Gateway.`,
            ),
          );
        }
      }
      return remaining;
    };
    let timer: ReturnType<typeof setTimeout>;
    const watch = () => {
      const remaining = inspect();
      if (remaining > 0) {
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
      clearTimeout(timer);
      port1.close();
      worker.postMessage("stop", []);
      termination ??= worker.terminate();
    };
    runtimeGeneration?.retain(worker, async () => async () => {
      stop();
      await termination;
    });
    return {
      worker,
      paths: new Set(Object.keys(locks)),
      inspect,
      stop,
    };
  });
}
