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
const monotonic = process.hrtime.bigint.bind(process.hrtime);

/** Native main-thread work cannot stall renewal; an expired worker never resumes custody. */
export function runGatewayStateOwnerHeartbeat(
  data: GatewayStateOwnerHeartbeatData,
  parent: MessagePort | null,
) {
  const lastBeat = new BigInt64Array(data.lastBeat);
  const now = () => monotonic() / 1_000_000n;
  const rootPath = Object.keys(data.locks)[0];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backoff = 0;
  const stop = () => {
    clearTimeout(timer);
    data.events.close();
    parent?.close();
  };
  const beat = () => {
    const beatStartedAt = now();
    const remaining = data.failureMs - Number(beatStartedAt - Atomics.load(lastBeat, 0));
    if (remaining <= 0) {
      stop();
      return;
    }
    let failure: string | null = null;
    for (const [lockPath, raw] of Object.entries(data.locks)) {
      try {
        if (!fs.existsSync(lockPath) || fs.readFileSync(lockPath, "utf8") !== raw) {
          if (lockPath === rootPath) {
            data.events.postMessage(`${lockPath}: owner lock was removed or replaced`, []);
            stop();
            return;
          }
          continue;
        }
        const stamp = new Date();
        fs.utimesSync(lockPath, stamp, stamp);
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT") && lockPath !== rootPath) {
          continue;
        }
        failure ??= `${lockPath}: utimes renewal failed: ${coerceErrorMessage(error)}`;
      }
    }
    if (Number(now() - Atomics.load(lastBeat, 0)) >= data.failureMs) {
      stop();
      return;
    }
    data.events.postMessage(failure, []);
    if (!failure) {
      // A slow syscall must not publish authority newer than the mtime supplied to it.
      Atomics.store(lastBeat, 0, beatStartedAt);
    }
    backoff = failure ? Math.min(backoff ? backoff * 2 : 1_000, data.intervalMs, remaining) : 0;
    timer = setTimeout(beat, backoff || data.intervalMs);
    timer.unref();
  };
  parent?.on("message", (message: "stop" | [string, string]) => {
    if (message === "stop") {
      stop();
    } else {
      data.locks[message[0]] = message[1];
    }
  });
  parent?.on("close", stop);
  beat();
  parent?.postMessage(null, []);
}
