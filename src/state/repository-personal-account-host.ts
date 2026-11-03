import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  withOpenClawStateLeaseAsync,
  type OpenClawStateAsyncLeaseContext,
} from "./openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import {
  observeUserGitHubConnectionAuthority,
  observeUserGitHubProfileRetirement,
} from "./user-github-connection-events.js";
import {
  listUserGitHubConnectionsAsync,
  mutateUserGitHubConnection,
  updateUserGitHubRefreshAsync,
} from "./user-github-connections.js";

/** Existing native account backend. New mutation/lease admission stops with the service; exact refresh CAS settlement drains. */
export function createRepositoryPersonalAccountHostV1(signal: AbortSignal) {
  const retirements = new Set<() => void>();
  // Preserve the native owner's empty-inventory fast path; all connection commits publish receipts.
  let connectionScan: { databasePath: string; current: boolean; empty: boolean } | undefined;
  const unobserveConnections = observeUserGitHubConnectionAuthority(({ databasePath }) => {
    if (connectionScan?.databasePath === databasePath) {
      connectionScan.current = false;
    }
  });
  const close = () => {
    unobserveConnections();
    for (const stop of retirements) {
      stop();
    }
    retirements.clear();
  };
  if (signal.aborted) {
    close();
  } else {
    signal.addEventListener("abort", close, { once: true });
  }
  return {
    mutate(...args: Parameters<typeof mutateUserGitHubConnection>) {
      signal.throwIfAborted();
      return mutateUserGitHubConnection(...args);
    },
    /** A remote refresh already rotated the selected token; the existing exact operation CAS owns settlement. */
    settleRefresh(...args: Parameters<typeof updateUserGitHubRefreshAsync>) {
      return updateUserGitHubRefreshAsync(...args);
    },
    async withProfile<T>(
      profileId: string,
      run: (lease: OpenClawStateAsyncLeaseContext) => Promise<T>,
    ): Promise<T> {
      signal.throwIfAborted();
      return await withOpenClawStateLeaseAsync(
        {
          scope: "personal-github-profile",
          key: profileId,
          leaseMs: 60000,
          waitMs: 30000,
          heartbeat: "worker",
        },
        captureOpenClawStateWorkerContext(),
        run,
      );
    },
    async listForMaintenance() {
      signal.throwIfAborted();
      const databasePath = resolveOpenClawStateSqlitePath();
      if (
        connectionScan?.databasePath === databasePath &&
        connectionScan.current &&
        connectionScan.empty
      ) {
        return [];
      }
      const scan = { databasePath, current: true, empty: false };
      connectionScan = scan;
      const connections = await listUserGitHubConnectionsAsync();
      // A receipt while reading invalidates this exact scan, as it did before extraction.
      scan.empty = connections.length === 0;
      return connections;
    },
    observeRetirements(listener: (profileIds: readonly string[]) => void) {
      signal.throwIfAborted();
      const stop = observeUserGitHubProfileRetirement((ids) => {
        if (!signal.aborted) {
          listener(ids);
        }
      });
      const release = () => {
        retirements.delete(release);
        stop();
      };
      retirements.add(release);
      return release;
    },
  };
}
