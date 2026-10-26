import fs from "node:fs";
import type { MessagePort } from "node:worker_threads";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { requestCliParentTermination } from "../../cli-parent-lifetime.mjs";
import { hasErrnoCode } from "./errno.js";
import {
  isGatewayMaintenanceParentStale,
  parseGatewayLockPayload,
} from "./gateway-lock-payload.js";

export type GatewayStateOwnerVerification = {
  type: "verified";
  id: number;
  current: boolean;
  error?: string;
};

type HeartbeatCommand = "stop" | [string, string] | { type: "verify"; id: number; paths: string[] };

export type GatewayStateOwnerHeartbeatData = {
  clock?: "epoch";
  locks: Record<string, string>;
  intervalMs: number;
  failureMs: number;
  lastBeat: SharedArrayBuffer;
  events: MessagePort;
};

function selectHeartbeatClock(data: GatewayStateOwnerHeartbeatData, seed: bigint) {
  if (data.clock === "epoch") {
    return "epoch";
  }
  const payload = parseGatewayLockPayload(Object.values(data.locks)[0] ?? "");
  const createdAt = Date.parse(payload?.createdAt ?? "");
  const epoch = Date.now();
  const monotonic = process.hrtime.bigint() / 1_000_000n;
  if (!Number.isFinite(createdAt) || createdAt > epoch || monotonic >= BigInt(createdAt)) {
    return undefined;
  }
  // Shipped drivers omitted the clock. Classify its domain once without refreshing custody.
  const processStart = monotonic - BigInt(Math.ceil(process.uptime() * 1_000));
  if (!process.versions.bun && seed >= processStart && seed <= monotonic) {
    return "monotonic";
  }
  return seed >= BigInt(createdAt) && seed <= BigInt(epoch) ? "epoch" : undefined;
}

/** Both I/O adapters compare the held descriptor, real leaf, and acquisition bytes. */
export function isGatewayStateOwnerLockSnapshotCurrent(
  held: fs.BigIntStats,
  current: fs.BigIntStats,
  expected: string,
  actual: string,
): boolean {
  return (
    current.isFile() &&
    held.nlink !== 0n &&
    held.dev === current.dev &&
    held.ino === current.ino &&
    actual === expected
  );
}

/** The same physical check serves renewal and fresh worker-dispatch admission. */
function verifyGatewayStateOwnerLock(fd: number, lockPath: string, raw: string): boolean {
  const held = fs.fstatSync(fd, { bigint: true });
  const current = fs.lstatSync(lockPath, { bigint: true });
  const bytes = Buffer.alloc(Buffer.byteLength(raw) + 1);
  const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
  if (
    !isGatewayStateOwnerLockSnapshotCurrent(
      held,
      current,
      raw,
      bytes.subarray(0, length).toString("utf8"),
    )
  ) {
    return false;
  }
  const after = fs.lstatSync(lockPath, { bigint: true });
  return after.isFile() && held.dev === after.dev && held.ino === after.ino;
}

/** Verify the held inode and exact acquisition bytes before touching it. */
export function renewGatewayStateOwnerLock(fd: number, lockPath: string, raw: string, stamp: Date) {
  if (!verifyGatewayStateOwnerLock(fd, lockPath, raw)) {
    return false;
  }
  // Suspension can only touch this held inode, never its successor.
  fs.futimesSync(fd, stamp, stamp);
  return true;
}

/** Native main-thread work cannot stall renewal; clock gaps require physical custody checks. */
export function runGatewayStateOwnerHeartbeat(
  data: GatewayStateOwnerHeartbeatData,
  parent: MessagePort | null,
) {
  const lastBeat = new BigInt64Array(data.lastBeat);
  const rootPath = Object.keys(data.locks)[0];
  const owner = parseGatewayLockPayload(rootPath === undefined ? "" : (data.locks[rootPath] ?? ""));
  const clock = selectHeartbeatClock(data, Atomics.load(lastBeat, 0));
  if (!clock) {
    data.events.postMessage(`${rootPath}: heartbeat clock could not be identified`, []);
    data.events.close();
    parent?.close();
    return;
  }
  const now =
    clock === "epoch" ? () => BigInt(Date.now()) : () => process.hrtime.bigint() / 1_000_000n;
  const remainingMs = () => {
    const age = Number(now() - Atomics.load(lastBeat, 0));
    return age < 0 ? 0 : data.failureMs - age;
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
  let parentLost = false;
  const beat = () => {
    // Keep renewing custody while cancellation settles; peers must not race its rollback.
    if (!parentLost && owner?.pid === process.pid && isGatewayMaintenanceParentStale(owner)) {
      parentLost = true;
      requestCliParentTermination(() => data.events.postMessage("parent-lost", []));
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
        const renewalStartedAt = now();
        const stamp = new Date(clock === "epoch" ? Number(renewalStartedAt) : Date.now());
        if (!renewGatewayStateOwnerLock(fd, lockPath, raw, stamp)) {
          if (lockPath === rootPath) {
            data.events.postMessage(`${lockPath}: owner lock was removed or replaced`, []);
            stop();
            return;
          }
          forget(lockPath);
          continue;
        }
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
    data.events.postMessage(failure, []);
    if (failure && remainingMs() <= 0) {
      stop();
      return;
    }
    if (!failure && renewedAt !== undefined) {
      // A slow syscall must not publish authority newer than the mtime supplied to it.
      Atomics.store(lastBeat, 0, renewedAt);
    }
    backoff = failure ? Math.min(backoff ? backoff * 2 : 1_000, data.intervalMs, remainingMs()) : 0;
    timer = setTimeout(beat, backoff || data.intervalMs);
    timer.unref();
  };
  parent?.on("message", (message: HeartbeatCommand) => {
    if (message === "stop") {
      stop();
    } else if (!Array.isArray(message)) {
      const result: GatewayStateOwnerVerification = {
        type: "verified",
        id: message.id,
        current: !stopped,
      };
      try {
        for (const lockPath of message.paths) {
          const raw = data.locks[lockPath];
          if (raw === undefined) {
            result.current = false;
            break;
          }
          let fd = descriptors.get(lockPath);
          if (fd === undefined) {
            fd = fs.openSync(lockPath, "r+");
            descriptors.set(lockPath, fd);
          }
          if (!verifyGatewayStateOwnerLock(fd, lockPath, raw)) {
            result.current = false;
            break;
          }
        }
      } catch (error) {
        result.current = false;
        if (!hasErrnoCode(error, "ENOENT")) {
          result.error = coerceErrorMessage(error);
        }
      }
      data.events.postMessage(result, []);
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
