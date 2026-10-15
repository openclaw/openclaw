import { AsyncLocalStorage } from "node:async_hooks";
import { isPathInside } from "@openclaw/fs-safe/path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const artifactPreservingReads = resolveGlobalSingleton(
  Symbol.for("openclaw.artifactPreservingStateReads"),
  () =>
    new AsyncLocalStorage<
      | {
          agentDatabases: boolean;
          readers: Set<() => void>;
          privateRoots: Set<string>;
        }
      | false
    >(),
);

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
  };
  const finish = (value: unknown, errors: unknown[] = []) => {
    for (const close of scope.readers) {
      try {
        close();
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
    ? Promise.resolve(result).then(finish, (error: unknown) => finish(undefined, [error]))
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
