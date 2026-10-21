import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { onSqliteWalCheckpoint } from "./sqlite-wal-checkpoint.js";

// A PASSIVE tick is expected to lose to live readers occasionally; a WAL that stays
// blocked for this many consecutive observations has a stranded reader (for example a
// pooled worker connection holding an abandoned native cursor). Rotate the readers so
// their connections close and the pinned WAL read mark is released.
const WAL_BLOCKED_RECOVERY_THRESHOLD = 12;
const WAL_BLOCKED_RECOVERY_COOLDOWN_MS = 10 * 60_000;

type WalBlockedReaderRecoveryRegistry = {
  hooks: Set<() => void | Promise<void>>;
  armed: boolean;
  lastRecoveryAtMs: number;
};

function recoveryRegistry(): WalBlockedReaderRecoveryRegistry {
  return resolveGlobalSingleton(Symbol.for("openclaw.sqliteWalBlockedReaderRecovery"), () => ({
    hooks: new Set(),
    armed: false,
    lastRecoveryAtMs: 0,
  }));
}

/**
 * Registers a recovery hook invoked when any WAL stays blocked for a sustained run of
 * checkpoint observations. Hook failures are contained; diagnostics consumers cannot
 * change a native checkpoint outcome. Returns an unregister function.
 */
export function registerSqliteWalBlockedReaderRecovery(
  recover: () => void | Promise<void>,
): () => void {
  const registry = recoveryRegistry();
  registry.hooks.add(recover);
  if (!registry.armed) {
    registry.armed = true;
    onSqliteWalCheckpoint(({ health }) => {
      if (
        health.state !== "blocked" ||
        health.consecutiveBlocked < WAL_BLOCKED_RECOVERY_THRESHOLD
      ) {
        return;
      }
      const now = Date.now();
      if (now - registry.lastRecoveryAtMs < WAL_BLOCKED_RECOVERY_COOLDOWN_MS) {
        return;
      }
      registry.lastRecoveryAtMs = now;
      const hooks = [...registry.hooks];
      for (const hook of hooks) {
        void Promise.resolve()
          .then(hook)
          .catch(() => {
            process.emitWarning("WAL blocked-reader recovery failed", {
              code: "SQLITE_WAL_BLOCKED_RECOVERY_FAILED",
            });
          });
      }
    });
  }
  return () => {
    registry.hooks.delete(recover);
  };
}
