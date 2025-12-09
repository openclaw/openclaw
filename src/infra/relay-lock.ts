import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_LOCK_PATH = path.join(os.tmpdir(), "clawdis-relay.lock");

export class RelayLockError extends Error {}

type ReleaseFn = () => Promise<void>;

/**
 * Acquire an exclusive single-instance lock for the relay using a Unix domain socket.
 *
 * Why a socket? If the process crashes or is SIGKILLed, the socket file remains but
 * the next start will detect ECONNREFUSED when connecting and clean the stale path
 * before retrying. This keeps the lock self-healing without manual pidfile cleanup.
 */
export async function acquireRelayLock(
  lockPath = DEFAULT_LOCK_PATH,
): Promise<ReleaseFn> {
  // Fast path: try to listen on the lock path.
  const attemptListen = (): Promise<net.Server> =>
    new Promise((resolve, reject) => {
      const server = net.createServer();

      server.once("error", async (err: NodeJS.ErrnoException) => {
        if (err.code !== "EADDRINUSE") {
          reject(new RelayLockError(`lock listen failed: ${err.message}`));
          return;
        }

        // Something is already bound. Try to connect to see if it is alive.
        const client = net.connect({ path: lockPath });

        client.once("connect", () => {
          client.destroy();
          reject(
            new RelayLockError("another relay instance is already running"),
          );
        });

        client.once("error", (connErr: NodeJS.ErrnoException) => {
          // Nothing is listening -> stale socket file. Remove and retry once.
          if (connErr.code === "ECONNREFUSED" || connErr.code === "ENOENT") {
            try {
              fs.rmSync(lockPath, { force: true });
            } catch (rmErr) {
              reject(
                new RelayLockError(
                  `failed to clean stale lock at ${lockPath}: ${String(rmErr)}`,
                ),
              );
              return;
            }
            attemptListen().then(resolve, reject);
            return;
          }

          reject(
            new RelayLockError(
              `failed to connect to existing lock (${lockPath}): ${connErr.message}`,
            ),
          );
        });
      });

      server.listen(lockPath, () => resolve(server));
    });

  const server = await attemptListen();

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* ignore */
    }
  };

  const cleanupSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handleSignal = async () => {
    await release();
    process.exit(0);
  };

  for (const sig of cleanupSignals) {
    process.once(sig, () => {
      void handleSignal();
    });
  }
  process.once("exit", () => {
    // Exit handler must be sync-safe; release is async but close+rm are fast.
    void release();
  });

  return release;
}
