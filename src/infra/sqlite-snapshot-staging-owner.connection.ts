import { createRetainedOperation, type RetainedOperation } from "./retained-operation.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import {
  SqliteSnapshotCleanupError,
  sealRetainedSnapshotTempDirectory,
} from "./sqlite-readonly-location-cleanup.js";
import { createSqliteReadOnlyNativeResourceConnection } from "./sqlite-readonly-native-resource.client.js";
import { sameTokenIdentity } from "./sqlite-snapshot-staging-owner.token.js";
import type {
  SqliteStagingNativeDirectory,
  SqliteStagingOwnedDirectory,
  SqliteStagingOwnedToken,
  SqliteStagingPreparation,
} from "./sqlite-snapshot-staging.types.js";

export function createSqliteStagingNativeConnection(options: {
  nativeDirectories: Map<string, SqliteStagingNativeDirectory>;
  directories: Map<string, SqliteStagingOwnedDirectory | SqliteStagingOwnedToken>;
  preparations: Map<number, SqliteStagingPreparation>;
  retainDirectory: (directory: string) => SqliteStagingOwnedDirectory;
  onFailure: (error: unknown) => void;
}) {
  const { nativeDirectories, directories, preparations, retainDirectory } = options;
  return createSqliteReadOnlyNativeResourceConnection({
    receive(value, owner) {
      const directory = value.directory;
      const existing = nativeDirectories.get(directory);
      if (
        value.type === "token-reserved" ||
        value.type === "token-admitted" ||
        value.type === "token-unavailable" ||
        value.type === "token-disposition" ||
        value.type === "token-settled"
      ) {
        const owned = directories.get(directory);
        const preparation = preparations.get(value.preparationId);
        if (
          owned?.kind !== "token" ||
          owned.preparationId !== value.preparationId ||
          !preparation?.isAdmitted()
        ) {
          throw new SqliteSnapshotCleanupError("SQLite staging token has no original admission");
        }
        preparation.acceptOwner(owner);
        if (
          existing &&
          (existing.kind !== "token" ||
            existing.owner !== owner ||
            existing.preparationId !== value.preparationId)
        ) {
          throw new SqliteSnapshotCleanupError(
            "SQLite staging token changed its original native owner",
          );
        }
        if (value.type === "token-reserved") {
          if (value.mode !== owned.mode || !sameTokenIdentity(owned.identity, value.identity)) {
            throw new SqliteSnapshotCleanupError(
              "SQLite staging token changed its captured inode identity",
            );
          }
          if (!existing) {
            nativeDirectories.set(directory, {
              kind: "token",
              owner,
              preparationId: value.preparationId,
              removed: false,
              recovering: false,
            });
          }
          return undefined;
        }
        if (
          !existing &&
          value.type !== "token-disposition" &&
          !(value.type === "token-settled" && value.disposition === "not-started")
        ) {
          throw new SqliteSnapshotCleanupError("SQLite staging token lost its native reservation");
        }
        if (value.type === "token-admitted") {
          if (!owned.unavailable && !owned.intent && !owned.terminal) {
            owned.admitted = true;
          }
        } else if (value.type === "token-unavailable") {
          owned.unavailable = true;
        } else if (value.type === "token-disposition") {
          if (!owned.intent) {
            throw new SqliteSnapshotCleanupError("SQLite staging token still has its plugin owner");
          }
          owned.unavailable = true;
          return { disposition: owned.intent };
        } else if (value.type === "token-settled") {
          if (
            !owned.intent ||
            (owned.intent === "retire" && value.disposition === "closed") ||
            (owned.admitted && value.disposition === "not-started")
          ) {
            throw new SqliteSnapshotCleanupError(
              "SQLite staging token did not acknowledge requested retirement",
            );
          }
          owned.unavailable = true;
          owned.terminal = value.disposition;
          if (existing) {
            existing.removed = true;
          }
        }
        return undefined;
      }
      if (value.type === "allocated") {
        const preparation = preparations.get(value.preparationId);
        if (!preparation?.isAdmitted()) {
          throw new SqliteSnapshotCleanupError(
            "SQLite snapshot preparation custody is unavailable",
          );
        }
        preparation.acceptOwner(owner);
        if (
          existing &&
          (existing.owner !== owner || existing.preparationId !== value.preparationId)
        ) {
          throw new SqliteSnapshotCleanupError("SQLite snapshot changed its original native owner");
        }
        if (!existing) {
          nativeDirectories.set(directory, {
            kind: "snapshot",
            owner,
            preparationId: value.preparationId,
            removed: false,
            recovering: false,
          });
        }
        preparation.directories.add(directory);
        retainDirectory(directory);
        if (preparation.closeRequested) {
          try {
            sealRetainedSnapshotTempDirectory(directory);
          } catch {
            // The request's actual removal reports a held reader; allocation still records custody.
          }
        }
      } else {
        if (existing?.owner !== owner) {
          throw new SqliteSnapshotCleanupError("SQLite snapshot native custody is unavailable");
        }
        if (value.type === "retire") {
          sealRetainedSnapshotTempDirectory(directory, { requireRequested: true });
          existing.recovering = true;
        } else if (value.type === "removed") {
          existing.removed = true;
        }
      }
      return undefined;
    },
    onFailure(error) {
      options.onFailure(error);
      for (const owned of directories.values()) {
        if (owned.kind === "token") {
          owned.unavailable = true;
        }
      }
    },
    onDispose(owner) {
      for (const [directory, record] of nativeDirectories) {
        const owned = directories.get(directory);
        if (record.owner === owner && owned?.kind === "token") {
          owned.unavailable = true;
        }
        if (record.owner === owner && record.removed && !directories.has(directory)) {
          nativeDirectories.delete(directory);
        }
      }
    },
  });
}

/** Join original native resources before rotating an idle execution worker. */
export function startSqliteStagingIdleClose(options: {
  hasWork: () => boolean;
  startCloseResources: () => RetainedOperation<void>;
  startRotate: () => RetainedOperation<void>;
  onRotated: () => void;
}): RetainedOperation<void> {
  let close: RetainedOperation<void> | undefined;
  let rotate: RetainedOperation<void> | undefined;
  const retained = createRetainedOperation<void>(() => {
    if (retained.operation.read().status !== "pending") {
      return;
    }
    if (!close) {
      if (options.hasWork()) {
        return retained.resolve(undefined);
      }
      close = options.startCloseResources();
      void close.result.then(serviceIdleClose, serviceIdleClose);
    }
    close.service();
    const closed = close.read();
    if (closed.status === "pending") {
      return;
    }
    if (closed.status === "rejected") {
      return retained.reject(closed.error);
    }
    if (!rotate) {
      if (options.hasWork()) {
        return retained.resolve(undefined);
      }
      rotate = options.startRotate();
      void rotate.result.then(serviceIdleClose, serviceIdleClose);
    }
    rotate.service();
    const rotated = rotate.read();
    if (rotated.status === "fulfilled") {
      options.onRotated();
      retained.resolve(undefined);
    } else if (rotated.status === "rejected") {
      retained.reject(rotated.error);
    }
  });
  const serviceIdleClose = retained.operation.service.bind(retained.operation);
  return retained.operation;
}

export async function closeSqliteStagingGeneration(options: {
  directories: ReadonlyMap<string, SqliteStagingOwnedDirectory | SqliteStagingOwnedToken>;
  preparations: ReadonlyMap<number, SqliteStagingPreparation>;
  requests: ReadonlySet<{ readonly result: Promise<unknown> }>;
  closeAdmission: () => void;
  closeWhenIdle: () => RetainedOperation<void>;
  closePool: () => Promise<void>;
}): Promise<void> {
  const { directories, preparations } = options;
  options.closeAdmission();
  for (const preparation of preparations.values()) {
    const heldToken = [...preparation.directories].some((directory) => {
      const owned = directories.get(directory);
      return owned?.kind === "token" && !owned.intent;
    });
    if (!heldToken) {
      preparation.closeRequested = true;
    }
  }
  await Promise.allSettled([...options.requests].map((request) => request.result));
  // A lost Worker shares native cleanup across roots; admit eligible siblings first.
  for (const [directory, owned] of directories) {
    if (owned.kind !== "snapshot") {
      continue;
    }
    try {
      sealRetainedSnapshotTempDirectory(directory);
    } catch {
      // Removal below rechecks and reports refusal, including readers released meanwhile.
    }
  }
  const closures: RetainedOperation<void>[] = [];
  const failures: unknown[] = [];
  for (const preparation of preparations.values()) {
    const heldToken = [...preparation.directories].some((directory) => {
      const owned = directories.get(directory);
      return owned?.kind === "token" && !owned.intent;
    });
    if (heldToken) {
      failures.push(
        new SqliteSnapshotCleanupError("SQLite staging token still has its plugin owner"),
      );
    } else {
      closures.push(preparation.startClose());
    }
  }
  const outcomes = await Promise.allSettled(closures.map((close) => close.result));
  failures.push(
    ...outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : [])),
  );
  if (failures.length) {
    throw createSqliteLifecycleAggregateError(
      failures,
      "SQLite snapshot generation cleanup failed",
      failures[0],
    );
  }
  await options.closeWhenIdle().result;
  await options.closePool();
}
