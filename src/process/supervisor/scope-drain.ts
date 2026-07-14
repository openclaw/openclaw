import type { ManagedRun, TerminationReason } from "./types.js";

const SCOPE_DRAIN_POLL_INTERVAL_MS = 10;

export type ScopedProcessTreeOwner = {
  scopeKey: string;
  forceKillAndWait: (timeoutMs: number) => Promise<boolean>;
  probeAlive: () => Promise<boolean | undefined>;
};

type ScopedRun = {
  run: ManagedRun;
  scopeKey?: string;
};

/** Owns spawn fences and native process-tree proofs for supervisor scopes. */
export function createProcessScopeDrainer(params: {
  listActiveRuns: () => Iterable<[string, ScopedRun]>;
}) {
  const processTrees = new Map<string, ScopedProcessTreeOwner>();
  const pendingSpawns = new Map<string, number>();
  const drainingScopes = new Map<string, { reason: TerminationReason }>();

  const beginSpawn = (scopeKey: string | undefined): (() => void) => {
    if (!scopeKey) {
      return () => undefined;
    }
    const drain = drainingScopes.get(scopeKey);
    if (drain) {
      throw new Error(`process scope ${scopeKey} is being drained (${drain.reason})`);
    }
    pendingSpawns.set(scopeKey, (pendingSpawns.get(scopeKey) ?? 0) + 1);
    return () => {
      const remaining = (pendingSpawns.get(scopeKey) ?? 1) - 1;
      if (remaining <= 0) {
        pendingSpawns.delete(scopeKey);
      } else {
        pendingSpawns.set(scopeKey, remaining);
      }
    };
  };

  const registerProcessTree = (runId: string, owner: ScopedProcessTreeOwner): void => {
    processTrees.set(runId, owner);
  };

  const releaseProcessTreeIfExited = async (
    runId: string,
    owner: ScopedProcessTreeOwner,
  ): Promise<void> => {
    if (processTrees.get(runId) === owner && (await owner.probeAlive()) === false) {
      processTrees.delete(runId);
    }
  };

  const cancelLateSpawn = (scopeKey: string | undefined, run: ManagedRun): void => {
    const drain = scopeKey ? drainingScopes.get(scopeKey) : undefined;
    if (drain) {
      run.cancel(drain.reason);
    }
  };

  const cancelScopeAndWait = async (
    scopeKey: string,
    options: { timeoutMs: number; reason?: TerminationReason },
  ): Promise<void> => {
    const drain =
      drainingScopes.get(scopeKey) ??
      (() => {
        const created = { reason: options.reason ?? ("manual-cancel" as const) };
        drainingScopes.set(scopeKey, created);
        return created;
      })();
    const deadline = Date.now() + options.timeoutMs;
    const confirmations = new Map<
      string,
      { promise: Promise<void>; confirmed?: boolean; error?: unknown }
    >();
    let drained = false;
    try {
      while (Date.now() < deadline) {
        const activeRuns = [...params.listActiveRuns()].filter(
          ([, current]) => current.scopeKey === scopeKey,
        );
        const scopedTrees = [...processTrees.entries()].filter(
          ([, current]) => current.scopeKey === scopeKey,
        );
        for (const [runId, owner] of scopedTrees) {
          if (confirmations.has(runId)) {
            continue;
          }
          const confirmation: {
            promise: Promise<void>;
            confirmed?: boolean;
            error?: unknown;
          } = { promise: Promise.resolve() };
          confirmation.promise = owner
            .forceKillAndWait(Math.max(1, deadline - Date.now()))
            .then((confirmed) => {
              confirmation.confirmed = confirmed;
              if (confirmed && processTrees.get(runId) === owner) {
                processTrees.delete(runId);
              }
            })
            .catch((error: unknown) => {
              confirmation.confirmed = false;
              confirmation.error = error;
            });
          confirmations.set(runId, confirmation);
        }
        for (const [, current] of activeRuns) {
          current.run.cancel(drain.reason);
        }
        const failedConfirmation = [...confirmations.entries()].find(
          ([, confirmation]) => confirmation.confirmed === false,
        );
        if (failedConfirmation) {
          const [runId, confirmation] = failedConfirmation;
          throw new Error(
            `could not confirm process-tree termination for run ${runId} in scope ${scopeKey}`,
            confirmation.error === undefined ? undefined : { cause: confirmation.error },
          );
        }
        const retainedTreeCount = [...processTrees.values()].filter(
          (owner) => owner.scopeKey === scopeKey,
        ).length;
        if ((pendingSpawns.get(scopeKey) ?? 0) === 0 && retainedTreeCount === 0) {
          drained = true;
          return;
        }
        const remainingMs = Math.max(1, deadline - Date.now());
        const poll = new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(SCOPE_DRAIN_POLL_INTERVAL_MS, remainingMs));
        });
        const pendingConfirmations = [...confirmations.values()]
          .filter((confirmation) => confirmation.confirmed === undefined)
          .map((confirmation) => confirmation.promise);
        await (pendingConfirmations.length === 0
          ? poll
          : Promise.race([Promise.all(pendingConfirmations), poll]));
      }
      const liveRunIds = [...params.listActiveRuns()]
        .filter(([, current]) => current.scopeKey === scopeKey)
        .map(([runId]) => runId);
      const retainedTreeIds = [...processTrees.entries()]
        .filter(([, owner]) => owner.scopeKey === scopeKey)
        .map(([runId]) => runId);
      throw new Error(
        `timed out draining process scope ${scopeKey} ` +
          `(live runs: ${liveRunIds.join(", ") || "none"}; retained trees: ${
            retainedTreeIds.join(", ") || "none"
          }; pending spawns: ${pendingSpawns.get(scopeKey) ?? 0})`,
      );
    } finally {
      if (drained && drainingScopes.get(scopeKey) === drain) {
        drainingScopes.delete(scopeKey);
      }
    }
  };

  return {
    beginSpawn,
    cancelLateSpawn,
    cancelScopeAndWait,
    ownsRunId: (runId: string) => processTrees.has(runId),
    registerProcessTree,
    releaseProcessTreeIfExited,
  };
}
