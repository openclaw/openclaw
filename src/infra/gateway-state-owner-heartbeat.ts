import fs from "node:fs";
import { MessageChannel } from "node:worker_threads";
import { coerceErrorMessage, toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { requestCliParentTermination } from "../../cli-parent-lifetime.mjs";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { hasErrnoCode } from "./errno.js";
import { GATEWAY_OWNER_HEARTBEAT_MS } from "./gateway-lock-payload.js";
import {
  type GatewayStateOwnerHeartbeatData,
  type GatewayStateOwnerVerification,
  type GatewayStateOwnerHeartbeatLoss,
  renewGatewayStateOwnerLock,
  isGatewayStateOwnerLockSnapshotCurrent,
} from "./gateway-state-owner-heartbeat.runtime.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import { createCpuTrackedWorker } from "./worker-cpu.js";
import { recordWorkerMessage } from "./worker-message-metrics.js";

const now = Date.now.bind(Date);

type StateOwnerLock = { lockPath: string; verifyStillHeld(): boolean };
type HeartbeatEvent =
  | string
  | null
  | GatewayStateOwnerVerification
  | GatewayStateOwnerHeartbeatLoss;

function captureLock(lock: StateOwnerLock) {
  const raw = fs.readFileSync(lock.lockPath, "utf8");
  if (!lock.verifyStillHeld()) {
    throw new Error("OpenClaw state ownership is no longer current");
  }
  return raw;
}

/** Process and schema owners share one renewal worker and one failure deadline. */
export function startGatewayStateOwnerHeartbeat(
  heldLocks: ReadonlySet<StateOwnerLock>,
  onLost: (error: Error) => void,
) {
  const locks: Record<string, string> = {};
  for (const lock of heldLocks) {
    locks[lock.lockPath] = captureLock(lock);
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
    let nextVerification = 0;
    const pending = new Map<
      number,
      { resolve: (current: boolean) => void; reject: (error: Error) => void }
    >();
    const rejectPending = (error: Error) => {
      for (const request of pending.values()) {
        request.reject(error);
      }
      pending.clear();
      port1.unref();
    };
    // Parent expiration checks verify physical custody directly.
    port1.on("message", (message: HeartbeatEvent) => {
      recordWorkerMessage("lifecycle", "from_worker");
      if (message === "parent-lost") {
        requestCliParentTermination();
      } else if (message && typeof message === "object" && message.type === "lost") {
        onLost(new Error(`${message.error}; restart the Gateway.`));
      } else if (message && typeof message === "object" && message.type === "verified") {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (pending.size === 0) {
          port1.unref();
        }
        if (message.error) {
          request?.reject(new Error(message.error));
        } else {
          request?.resolve(message.current);
        }
      }
    });
    port1.unref();
    worker.on("error", (err) => {
      const error = new Error(`${coerceErrorMessage(err)}; restart Gateway.`);
      rejectPending(error);
      onLost(error);
    });
    worker.once("exit", () =>
      rejectPending(new Error("Gateway state ownership verification worker stopped")),
    );
    let termination: Promise<number> | undefined;
    const remainingUntilInspection = () => {
      const renewedAt = Atomics.load(lastBeat, 0);
      const age = now() - Number(renewedAt);
      return age < 0 ? 0 : 60_000 - age;
    };
    const inspect = () => {
      const remaining = remainingUntilInspection();
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
    // Synchronous native custody keeps inspect(); timers renew through async filesystem I/O.
    const renewAsync = async () => {
      const renewalStartedAt = now();
      const stamp = new Date(renewalStartedAt);
      for (const lock of heldLocks) {
        try {
          const raw = locks[lock.lockPath];
          if (raw === undefined) {
            throw new Error("owner acquisition bytes were not registered");
          }
          const file = await fs.promises.open(lock.lockPath, "r+");
          try {
            const held = await file.stat({ bigint: true });
            const current = await fs.promises.lstat(lock.lockPath, { bigint: true });
            const bytes = Buffer.alloc(Buffer.byteLength(raw) + 1);
            const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
            const after = await fs.promises.lstat(lock.lockPath, { bigint: true });
            if (termination || !heldLocks.has(lock)) {
              continue;
            }
            if (
              !isGatewayStateOwnerLockSnapshotCurrent(
                held,
                current,
                raw,
                bytes.subarray(0, bytesRead).toString("utf8"),
              ) ||
              !after.isFile() ||
              after.dev !== held.dev ||
              after.ino !== held.ino ||
              (lock.lockPath === rootPath &&
                (held.dev !== rootIdentity.dev || held.ino !== rootIdentity.ino))
            ) {
              if (lock.lockPath !== rootPath) {
                continue;
              }
              throw new Error("owner lock was removed or replaced");
            }
            // Release can only race a touch of this retained inode, never its successor.
            await file.utimes(stamp, stamp);
          } finally {
            await file.close();
          }
        } catch (error) {
          if (lock.lockPath !== rootPath && hasErrnoCode(error, "ENOENT")) {
            continue;
          }
          throw error;
        }
      }
      if (!termination && heldLocks.size > 0) {
        Atomics.store(lastBeat, 0, BigInt(renewalStartedAt));
      }
    };
    let timer: ReturnType<typeof setTimeout>;
    let renewal: Promise<void> | undefined;
    const watch = () => {
      const remaining = remainingUntilInspection();
      if (remaining > 0) {
        timer = setTimeout(watch, remaining);
        timer.unref();
      } else {
        renewal ??= renewAsync().then(
          () => {
            renewal = undefined;
            if (!termination) {
              watch();
            }
          },
          (error: unknown) => {
            renewal = undefined;
            if (!termination) {
              onLost(
                new Error(
                  `Gateway state ownership is no longer current at ${rootPath}: ${coerceErrorMessage(error)}; restart the Gateway.`,
                ),
              );
            }
          },
        );
      }
    };
    watch();
    const stop = () => {
      if (!termination) {
        clearTimeout(timer);
        rejectPending(new Error("Gateway state ownership is no longer current"));
        port1.close();
        worker.postMessage("stop", []);
        termination = worker.terminate();
      }
      return Promise.all([termination, renewal]).then(() => undefined);
    };
    runtimeGeneration?.retain(worker, async () => async () => {
      await stop();
    });
    const assertActive = () => {
      if (termination || worker.threadId === -1) {
        throw new Error("Gateway state ownership verification worker stopped");
      }
    };
    const paths = new Set(Object.keys(locks));
    return {
      worker,
      paths,
      register(lock: StateOwnerLock) {
        const raw = captureLock(lock);
        locks[lock.lockPath] = raw;
        worker.postMessage([lock.lockPath, raw], []);
        paths.add(lock.lockPath);
      },
      inspect,
      assertActive,
      verify(lockPaths: string[]): Promise<boolean> {
        assertActive();
        const id = ++nextVerification;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          port1.ref();
          try {
            worker.postMessage({ type: "verify", id, paths: lockPaths }, []);
          } catch (error) {
            pending.delete(id);
            if (pending.size === 0) {
              port1.unref();
            }
            reject(toErrorObject(error, "Gateway state ownership verification failed"));
          }
        });
      },
      stop,
    };
  });
}
