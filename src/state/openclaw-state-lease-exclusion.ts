import { AsyncLocalStorage } from "node:async_hooks";
// A paused heartbeat is not renewal. Retain the real file fence until the
// admitted operation settles, bounded by every owner's freshly read deadline.
import { throwSqliteLifecycleErrors } from "../infra/sqlite-coordinator.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
  type SqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "./openclaw-state-db-cache.js";
import type { CaptureOwner, LeaseExclusionParams } from "./openclaw-state-lease-owner.js";

// Only live lexical owners are composed. Other tasks/processes remain foreign
// handles; neither a pathname nor inherited serialized data grants admission.
const activeOwners = new AsyncLocalStorage<readonly CaptureOwner[]>();

/** Independent work must acquire its own lease instead of inheriting a prior file owner. */
export function runOutsideOpenClawStateLeaseScope<T>(run: () => T): T {
  return activeOwners.exit(run);
}

async function perform<T>(
  owners: readonly CaptureOwner[],
  databasePath: string,
  operation: (assertCurrent: () => void) => Promise<T>,
  bindCaptured?: (captured: T, assertCurrent: () => void) => undefined,
): Promise<T> {
  const errors: unknown[] = [];
  const participants = owners.map<{
    owner: CaptureOwner;
    paused: boolean;
    expiresAt?: number;
  }>((owner) => ({ owner, paused: false }));
  const assertActive = () => {
    for (const { owner } of participants) {
      owner.params.assertActive();
    }
  };
  const onLost = (error: Error) => {
    for (const { owner } of participants) {
      owner.params.onLost(error);
    }
  };
  const distrustCanonical = (error: Error) => {
    for (const { owner } of participants) {
      owner.cleanupAllowed = false;
    }
    onLost(error);
  };
  let result: T | undefined;
  let lifecycle: ReturnType<typeof acquireStateDatabaseCoordinator> | undefined;
  let exclusion: Awaited<ReturnType<typeof acquireOpenClawStateDatabaseFileExclusion>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation: SqliteFileGeneration | undefined;
  let active = true;
  try {
    for (const participant of participants) {
      await participant.owner.params.pause();
      participant.paused = true;
      assertActive();
    }
    lifecycle = acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 0 });
    for (const participant of participants) {
      participant.expiresAt = participant.owner.params.readExpiry(databasePath);
    }
    exclusion = await acquireOpenClawStateDatabaseFileExclusion(databasePath);
    generation = readStableSqliteFileGeneration(databasePath);
    const held = exclusion;
    const deadline = Math.min(...participants.map((participant) => participant.expiresAt ?? 0));
    const assertCurrent = () => {
      if (!active) {
        throw new Error("state lease file exclusion is no longer current");
      }
      assertActive();
      held.assertCurrent();
      if (Date.now() >= deadline) {
        const error = new Error("state lease expired during file exclusion");
        onLost(error);
        throw error;
      }
    };
    for (const { owner } of participants) {
      owner.assertion = assertCurrent;
    }
    timer = setTimeout(
      () => onLost(new Error("state lease expired during file exclusion")),
      Math.max(1, deadline - Date.now()),
    );
    timer.unref();
    assertCurrent();
    const captured = await held.runWithSourceReads(() => operation(assertCurrent));
    result = captured;
    assertCurrent();
    if (bindCaptured) {
      if (!sameSqliteFileGeneration(generation, readStableSqliteFileGeneration(databasePath))) {
        throw new Error("state lease source generation changed before binding");
      }
      const bindingErrors: unknown[] = [];
      try {
        await held.bindCaptured(assertCurrent, () => {
          const completion = bindCaptured(captured, assertCurrent);
          if (completion === undefined) {
            assertCurrent();
            for (const participant of participants) {
              if (participant.owner.params.readExpiry(databasePath) !== participant.expiresAt) {
                throw new Error("state lease changed during checkpoint binding");
              }
            }
          }
          return completion;
        });
      } catch (error) {
        bindingErrors.push(error);
      }
      try {
        const afterBinding = readStableSqliteFileGeneration(databasePath);
        // Canonical binding may update contents, never replace the source inode.
        const before = generation.database;
        const after = afterBinding.database;
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.birthtimeNs !== after.birthtimeNs
        ) {
          throw new Error("state lease source identity changed during checkpoint binding");
        }
        generation = afterBinding;
      } catch (error) {
        bindingErrors.push(error);
      }
      throwSqliteLifecycleErrors(bindingErrors, "state lease exclusion failed");
      assertCurrent();
    }
  } catch (error) {
    errors.push(error);
  }
  active = false;
  for (const { owner } of participants) {
    owner.assertion = undefined;
  }
  clearTimeout(timer);
  if (exclusion) {
    try {
      exclusion.assertCurrent();
      if (
        !generation ||
        !sameSqliteFileGeneration(generation, readStableSqliteFileGeneration(databasePath))
      ) {
        throw new Error("state lease source generation changed during capture");
      }
    } catch (error) {
      errors.push(error);
      distrustCanonical(new Error("state lease source binding refused", { cause: error }));
    }
  }
  try {
    exclusion?.release();
  } catch (error) {
    errors.push(error);
    distrustCanonical(new Error("state lease file exclusion release failed", { cause: error }));
  }
  // Reopen the same generation under lifecycle admission and check every exact
  // original owner/expiry before releasing it to renewal. This is not restore.
  try {
    assertActive();
    for (const participant of participants) {
      const reopenedExpiry = participant.owner.params.readExpiry(databasePath);
      if (participant.expiresAt !== undefined && reopenedExpiry !== participant.expiresAt) {
        throw new Error("state lease changed during file exclusion");
      }
      participant.expiresAt = reopenedExpiry;
    }
  } catch (error) {
    errors.push(error);
    distrustCanonical(new Error("state lease reopen refused", { cause: error }));
  } finally {
    try {
      lifecycle?.release();
    } catch (error) {
      errors.push(error);
      distrustCanonical(new Error("state lease exclusion release failed", { cause: error }));
    }
  }
  for (const participant of participants) {
    try {
      assertActive();
      if (participant.expiresAt === undefined) {
        throw new Error("state lease has no current durable expiry");
      }
      if (participant.paused) {
        await participant.owner.params.resume(participant.expiresAt);
      }
      assertActive();
    } catch (error) {
      errors.push(error);
    }
  }
  throwSqliteLifecycleErrors(errors, "state lease exclusion failed");
  // SAFETY: successful operation assigned result; every failure above is rethrown.
  return result as T;
}

export function createOpenClawStateLeaseExclusion(params: LeaseExclusionParams) {
  const ancestors = activeOwners.getStore() ?? [];
  const owner: CaptureOwner = {
    params,
    busy: false,
    cleanupAllowed: true,
    admissionClosed: false,
    admitted: [],
  };
  const admit = <T>(
    operation: (participants: CaptureOwner[], databasePath: string) => Promise<T>,
  ): Promise<T> => {
    const databasePath = owner.databasePath;
    if (!databasePath) {
      throw new Error("state lease has not entered its owner scope");
    }
    const participants = [...ancestors, owner].filter(
      (candidate) => candidate.databasePath === databasePath,
    );
    for (const candidate of participants) {
      candidate.params.assertActive();
      if (candidate.admissionClosed) {
        throw new Error("state lease no longer accepts file exclusion");
      }
      if (candidate.busy) {
        throw new Error("state lease file exclusion is already in progress");
      }
      if (candidate.params.databasePath() !== databasePath) {
        throw new Error("state lease database path changed during exclusion");
      }
    }
    for (const candidate of participants) {
      candidate.busy = true;
    }
    const task = operation(participants, databasePath).finally(() => {
      for (const candidate of participants) {
        candidate.busy = false;
      }
    });
    for (const candidate of participants) {
      candidate.admitted.push(task);
    }
    void task.catch(() => undefined);
    return task;
  };
  return {
    canRelease: () => owner.cleanupAllowed,
    runWithOwnerScope<T>(operation: () => Promise<T>): Promise<T> {
      // Resolve only inside the lease's protected callback entry/cleanup scope.
      params.assertActive();
      owner.databasePath = params.databasePath();
      return activeOwners.run([...ancestors, owner], operation);
    },
    assertIfExcluded() {
      if (!owner.assertion) {
        if (owner.busy) {
          throw new Error("state lease file exclusion is transitioning");
        }
        return false;
      }
      owner.assertion();
      return true;
    },
    run<T>(
      operation: (assertCurrent: () => void) => Promise<T>,
      bindCaptured?: (captured: T, assertCurrent: () => void) => undefined,
    ): Promise<T> {
      return admit((participants, databasePath) =>
        perform(participants, databasePath, operation, bindCaptured),
      );
    },
    async drain() {
      const errors: unknown[] = [];
      let drained = 0;
      while (drained < owner.admitted.length) {
        const batch = owner.admitted.slice(drained);
        drained += batch.length;
        const results = await Promise.allSettled(batch);
        for (const result of results) {
          if (result.status === "rejected") {
            errors.push(result.reason);
          }
        }
      }
      // Close admission in the same turn as the final empty check.
      owner.admissionClosed = true;
      throwSqliteLifecycleErrors(errors, "state lease exclusion failed");
    },
  };
}
