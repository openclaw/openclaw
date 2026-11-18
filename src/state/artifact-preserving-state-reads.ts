import { AsyncLocalStorage } from "node:async_hooks";
import { isPathInside } from "@openclaw/fs-safe/path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  throwSqliteLifecycleErrors,
  SqliteSnapshotCleanupError,
} from "../infra/sqlite-lifecycle-errors.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const artifactPreservingReads = resolveGlobalSingleton(
  Symbol.for("openclaw.artifactPreservingStateReads"),
  () =>
    new AsyncLocalStorage<
      | {
          agentDatabases: boolean;
          readers: Set<() => void>;
          privateRoots: Set<string>;
          snapshots: Map<
            string,
            PreparedSqliteReadOnlyLocation & { sourceIdentity: DatabasePathIdentity }
          >;
        }
      | false
    >(),
);

const liveStateReads = resolveGlobalSingleton(
  Symbol.for("openclaw.liveStateReads"),
  () => new AsyncLocalStorage<boolean>(),
);

/** Select live runtime state bytes without changing an inspection's side-effect policy. */
export function withLiveStateReads<T>(operation: () => T): T {
  return liveStateReads.run(true, operation);
}

export function isLiveStateRead(): boolean {
  return liveStateReads.getStore() === true;
}

/**
 * `agentDatabases` makes every agent-database read a private whole-file copy. It is for
 * offline inspection (Doctor, update checks). Gateway requests read live databases through
 * their owner; a copy of a multi-GB agent database blocks writers for minutes.
 */
export function withArtifactPreservingStateReads<T>(
  operation: () => T,
  options?: { agentDatabases?: true },
): T;
export function withArtifactPreservingStateReads(
  operation: () => unknown,
  options: { agentDatabases?: true } = {},
): unknown {
  if (isArtifactPreservingStateRead("agent")) {
    return operation();
  }
  // Mutable maintenance keeps source identities; only inspection opts into all readers.
  const scope = {
    agentDatabases: options.agentDatabases === true,
    readers: new Set<() => void>(),
    privateRoots: new Set<string>(),
    snapshots: new Map<
      string,
      PreparedSqliteReadOnlyLocation & { sourceIdentity: DatabasePathIdentity }
    >(),
  };
  const closeReaders = (errors: unknown[]) => {
    for (const close of scope.readers) {
      try {
        close();
      } catch (error) {
        errors.push(error);
      }
    }
  };
  const finish = (value: unknown, errors: unknown[] = []) => {
    closeReaders(errors);
    for (const snapshot of scope.snapshots.values()) {
      try {
        if (!snapshot.cleanup()) {
          throw new SqliteSnapshotCleanupError("SQLite inspection snapshot cleanup failed.");
        }
      } catch (error) {
        errors.push(error);
      }
    }
    throwSqliteLifecycleErrors(errors, "Artifact-preserving inspection and cleanup failed.");
    return value;
  };
  const finishAsync = async (value: unknown, errors: unknown[] = []) => {
    closeReaders(errors);
    for (const snapshot of scope.snapshots.values()) {
      try {
        if (!(await snapshot.cleanupAsync())) {
          throw new SqliteSnapshotCleanupError("SQLite inspection snapshot cleanup failed.");
        }
      } catch (error) {
        errors.push(error);
      }
    }
    throwSqliteLifecycleErrors(errors, "Artifact-preserving inspection and cleanup failed.");
    return value;
  };
  let result: unknown;
  try {
    result = artifactPreservingReads.run(scope, operation);
  } catch (error) {
    return finish(undefined, [error]);
  }
  return isPromiseLike(result)
    ? Promise.resolve(result).then(finishAsync, (error: unknown) => finishAsync(undefined, [error]))
    : finish(result);
}

export function isArtifactPreservingStateRead(
  kind: "shared" | "agent" = "shared",
  pathname?: string,
): boolean {
  const scope = artifactPreservingReads.getStore();
  return Boolean(
    scope &&
    (kind === "shared" || scope.agentDatabases) &&
    (!pathname || ![...scope.privateRoots].some((root) => isPathInside(root, pathname))),
  );
}
