import fs from "node:fs";
import type { MessagePort } from "node:worker_threads";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { hasErrnoCode } from "./errno.js";

export type GatewayStateOwnerHeartbeatData = {
  locks: Record<string, string>;
  intervalMs: number;
  failureMs: number;
  lastBeat: SharedArrayBuffer;
  events: MessagePort;
};

/** Native main-thread work cannot stall renewal; an expired worker never resumes custody. */
export function runGatewayStateOwnerHeartbeat(
  data: GatewayStateOwnerHeartbeatData,
  parent: MessagePort | null,
) {
  const lastBeat = new BigInt64Array(data.lastBeat);
  const now = () => BigInt(Date.now());
  const rootPath = Object.keys(data.locks)[0];
  const remainingMs = (at = now()) => {
    const renewedAt = Atomics.load(lastBeat, 0);
    const age = Number(at - renewedAt);
    if (age < 0) {
      data.events.postMessage(`${rootPath}: heartbeat clock moved backwards`, []);
      return 0;
    }
    return data.failureMs - age;
  };
  const descriptors = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backoff = 0;
  let stopped = false;
  const forget = (lockPath: string) => {
    const fd = descriptors.get(lockPath);
    if (fd !== undefined) {
      fs.closeSync(fd);
      descriptors.delete(lockPath);
    }
    delete data.locks[lockPath];
  };
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(timer);
    for (const lockPath of descriptors.keys()) {
      forget(lockPath);
    }
    data.events.close();
    parent?.close();
  };
  const beat = () => {
    const remaining = remainingMs();
    if (remaining <= 0) {
      stop();
      return;
    }
    let failure: string | null = null;
    let renewedAt: bigint | undefined;
    for (const [lockPath, raw] of Object.entries(data.locks)) {
      try {
        let fd = descriptors.get(lockPath);
        if (fd === undefined) {
          fd = fs.openSync(lockPath, "r+");
          descriptors.set(lockPath, fd);
        }
        const held = fs.fstatSync(fd, { bigint: true });
        const current = fs.statSync(lockPath, { bigint: true });
        const bytes = Buffer.alloc(Buffer.byteLength(raw) + 1);
        const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (
          held.nlink === 0n ||
          held.dev !== current.dev ||
          held.ino !== current.ino ||
          bytes.subarray(0, length).toString("utf8") !== raw
        ) {
          if (lockPath === rootPath) {
            data.events.postMessage(`${lockPath}: owner lock was removed or replaced`, []);
            stop();
            return;
          }
          forget(lockPath);
          continue;
        }
        const renewalStartedAt = now();
        // A recovered clock cannot make an older captured timestamp safe to write.
        if (remainingMs(renewalStartedAt) <= 0 || remainingMs() <= 0) {
          stop();
          return;
        }
        // A suspension after verification can only touch this held inode, never its successor.
        const stamp = new Date(Number(renewalStartedAt));
        fs.futimesSync(fd, stamp, stamp);
        if (renewedAt === undefined || renewalStartedAt < renewedAt) {
          renewedAt = renewalStartedAt;
        }
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          if (lockPath === rootPath) {
            data.events.postMessage(`${lockPath}: owner lock was removed or replaced`, []);
            stop();
            return;
          }
          forget(lockPath);
          continue;
        }
        failure ??= `${lockPath}: utimes renewal failed: ${coerceErrorMessage(error)}`;
      }
    }
    if (remainingMs() <= 0) {
      stop();
      return;
    }
    data.events.postMessage(failure, []);
    if (!failure && renewedAt !== undefined) {
      // A slow syscall must not publish authority newer than the mtime supplied to it.
      Atomics.store(lastBeat, 0, renewedAt);
    }
    backoff = failure ? Math.min(backoff ? backoff * 2 : 1_000, data.intervalMs, remaining) : 0;
    timer = setTimeout(beat, backoff || data.intervalMs);
    timer.unref();
  };
  parent?.on("message", (message: "stop" | [string, string]) => {
    if (message === "stop") {
      stop();
    } else {
      // Raw bytes include fs-safe's acquisition token; new projection custody may reuse a path.
      if (data.locks[message[0]] !== message[1]) {
        forget(message[0]);
      }
      data.locks[message[0]] = message[1];
    }
  });
  parent?.on("close", stop);
  beat();
  parent?.postMessage(null, []);
}
