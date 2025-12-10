import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { flockSync } from "fs-ext";

const DEFAULT_LOCK_PATH = path.join(os.tmpdir(), "clawdis-gateway.lock");

export class GatewayLockError extends Error {}

type ReleaseFn = () => Promise<void>;

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Acquire an exclusive gateway lock using POSIX flock and write the PID into the same file.
 *
 * Kernel locks are released automatically when the process exits or is SIGKILLed, so the
 * lock cannot become stale. A best-effort unlink on shutdown keeps the path clean, but
 * correctness relies solely on the kernel lock.
 */
export async function acquireGatewayLock(
  lockPath = DEFAULT_LOCK_PATH,
): Promise<ReleaseFn> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const fd = fs.openSync(lockPath, "w+");
  try {
    flockSync(fd, "exnb");
  } catch (err) {
    fs.closeSync(fd);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EWOULDBLOCK" || code === "EAGAIN") {
      throw new GatewayLockError("another gateway instance is already running");
    }
    throw new GatewayLockError(
      `failed to acquire gateway lock: ${(err as Error).message}`,
    );
  }

  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, `${process.pid}\n`, 0, "utf8");
  fs.fsyncSync(fd);

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      flockSync(fd, "un");
    } catch {
      /* ignore unlock errors */
    }
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore close errors */
    }
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* ignore unlink errors */
    }
  };

  const handleSignal = () => {
    void release();
    process.exit(0);
  };

  for (const sig of SIGNALS) {
    process.once(sig, handleSignal);
  }

  process.once("exit", () => {
    void release();
  });

  return release;
}
