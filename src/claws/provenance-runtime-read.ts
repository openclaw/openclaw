import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  assertOpenClawStateDatabaseOwner,
  resolveDatabasePath,
} from "../state/openclaw-state-db-maintenance.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  registerOpenClawStateDatabaseLifecycleListener,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  readClawInstallSchemaVersionRows,
  type ClawInstallSchemaVersionRow,
} from "./provenance-runtime-read.kernel.js";
import { parseClawInstallRecordSchemaVersion } from "./provenance-schema-version.js";

type ClawInstallSchemaVersionRead =
  | {
      kind: "ok";
      schemaVersion: ReturnType<typeof parseClawInstallRecordSchemaVersion>;
      agentConfigDigest: string;
    }
  | { kind: "error"; error: unknown };

type ClawInstallSchemaVersionSnapshot =
  | { kind: "ready"; schemaVersions: Map<string, ClawInstallSchemaVersionRead> }
  | {
      kind: "state-error";
      error: unknown;
      knownAgentIds: ReadonlySet<string>;
      ownershipUnknown: boolean;
    }
  | { kind: "uninitialized" };

// Refresh on every runtime config snapshot because another process may mutate Claw provenance.
const snapshotsByPath = new Map<string, ClawInstallSchemaVersionSnapshot>();
const snapshotListeners = new Set<() => void>();
const handedOffFacts = resolveGlobalSingleton(
  Symbol.for("openclaw.clawInstallSchemaVersionFacts"),
  () =>
    new AsyncLocalStorage<{
      path: string;
      snapshot: ClawInstallSchemaVersionSnapshot;
      active: boolean;
    }>(),
);

function notifySnapshotListeners(): void {
  for (const listener of snapshotListeners) {
    listener();
  }
}

function decodeSchemaVersions(
  rows: ClawInstallSchemaVersionRow[],
): ClawInstallSchemaVersionSnapshot {
  const schemaVersions = new Map<string, ClawInstallSchemaVersionRead>();
  for (const row of rows) {
    try {
      schemaVersions.set(row.agentId, {
        kind: "ok",
        schemaVersion: parseClawInstallRecordSchemaVersion(row.schemaVersion),
        agentConfigDigest: row.agentConfigDigest,
      });
    } catch (error) {
      schemaVersions.set(row.agentId, { kind: "error", error });
    }
  }
  return { kind: "ready", schemaVersions };
}

function readSchemaVersions(db: DatabaseSync): ClawInstallSchemaVersionSnapshot {
  try {
    return decodeSchemaVersions(readClawInstallSchemaVersionRows(db));
  } catch (error) {
    return {
      kind: "state-error",
      error,
      knownAgentIds: new Set(),
      ownershipUnknown: true,
    };
  }
}

function knownAgentIds(
  snapshot: ClawInstallSchemaVersionSnapshot | undefined,
): ReadonlySet<string> {
  if (snapshot?.kind === "ready") {
    return new Set(snapshot.schemaVersions.keys());
  }
  return snapshot?.kind === "state-error" ? snapshot.knownAgentIds : new Set();
}

function isOwnershipUnknown(snapshot: ClawInstallSchemaVersionSnapshot | undefined): boolean {
  return (
    !snapshot ||
    snapshot.kind === "uninitialized" ||
    (snapshot.kind === "state-error" && snapshot.ownershipUnknown)
  );
}

registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind === "failure-cleared") {
    return;
  }
  const previous = snapshotsByPath.get(event.kind === "opened" ? event.database.path : event.path);
  if (event.kind === "opened") {
    const snapshot = readSchemaVersions(event.database.db);
    snapshotsByPath.set(
      event.database.path,
      snapshot.kind === "state-error"
        ? {
            ...snapshot,
            knownAgentIds: knownAgentIds(previous),
            ownershipUnknown: isOwnershipUnknown(previous),
          }
        : snapshot,
    );
  } else if (event.kind === "open-error" || event.kind === "terminal-failure") {
    snapshotsByPath.set(event.path, {
      kind: "state-error",
      error: event.error,
      knownAgentIds: knownAgentIds(previous),
      ownershipUnknown: isOwnershipUnknown(previous),
    });
  } else {
    snapshotsByPath.set(event.path, {
      kind: "state-error",
      error: new Error("OpenClaw state database closed before consent provenance verification."),
      knownAgentIds: knownAgentIds(previous),
      ownershipUnknown: isOwnershipUnknown(previous),
    });
  }
  notifySnapshotListeners();
});

function resolveSnapshotPath(options: OpenClawStateDatabaseOptions): string {
  return options.database?.path ?? resolveDatabasePath(options);
}

/** Discovery workers consume the host's prepared facts, including failed or missing preparation. */
export function captureClawInstallSchemaVersionFacts(options: OpenClawStateDatabaseOptions = {}) {
  const path = resolveSnapshotPath(options);
  const snapshot = readCachedClawInstallSchemaVersions(options);
  if (snapshot.kind === "ready") {
    return {
      path,
      snapshot: {
        kind: snapshot.kind,
        schemaVersions: [...snapshot.schemaVersions].map(
          ([agentId, read]) =>
            [
              agentId,
              read.kind === "error" ? { ...read, error: formatErrorMessage(read.error) } : read,
            ] as const,
        ),
      },
    };
  }
  return {
    path,
    snapshot:
      snapshot.kind === "state-error"
        ? {
            ...snapshot,
            error: formatErrorMessage(snapshot.error),
            knownAgentIds: [...snapshot.knownAgentIds],
          }
        : snapshot,
  };
}

/** Includes late plugin imports, whose config preparers run immediately on registration. */
export function withClawInstallSchemaVersionFacts<T>(
  facts: ReturnType<typeof captureClawInstallSchemaVersionFacts>,
  operation: () => Promise<T>,
): Promise<T> {
  const snapshot: ClawInstallSchemaVersionSnapshot =
    facts.snapshot.kind === "ready"
      ? { ...facts.snapshot, schemaVersions: new Map(facts.snapshot.schemaVersions) }
      : facts.snapshot.kind === "state-error"
        ? { ...facts.snapshot, knownAgentIds: new Set(facts.snapshot.knownAgentIds) }
        : facts.snapshot;
  const scope = { path: facts.path, snapshot, active: true };
  return handedOffFacts.run(scope, async () => {
    try {
      return await operation();
    } finally {
      scope.active = false;
    }
  });
}

function readHandedOffFacts(options: OpenClawStateDatabaseOptions) {
  const scope = handedOffFacts.getStore();
  if (!scope) {
    return undefined;
  }
  if (!scope.active || scope.path !== resolveSnapshotPath(options)) {
    throw new Error("Claw provenance facts are outside their captured state scope.");
  }
  return scope.snapshot;
}

export function readCachedClawInstallSchemaVersions(
  options: OpenClawStateDatabaseOptions = {},
): ClawInstallSchemaVersionSnapshot {
  return (
    readHandedOffFacts(options) ??
    snapshotsByPath.get(resolveSnapshotPath(options)) ?? { kind: "uninitialized" }
  );
}

export function initializeCachedClawInstallSchemaVersions(
  options: OpenClawStateDatabaseOptions = {},
): void {
  if (readHandedOffFacts(options)) {
    notifySnapshotListeners();
    return;
  }
  const path = resolveSnapshotPath(options);
  const previous = snapshotsByPath.get(path);
  try {
    const snapshot = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db, path: pathname }) => {
        assertOpenClawStateDatabaseOwner(db, { pathname });
        return readSchemaVersions(db);
      },
      options,
    );
    snapshotsByPath.set(path, resolveSchemaVersionSnapshot(snapshot, previous));
  } catch (error) {
    snapshotsByPath.set(path, {
      kind: "state-error",
      error,
      knownAgentIds: knownAgentIds(previous),
      ownershipUnknown: true,
    });
  }
  notifySnapshotListeners();
}

function resolveSchemaVersionSnapshot(
  snapshot: ClawInstallSchemaVersionSnapshot | undefined,
  previous: ClawInstallSchemaVersionSnapshot | undefined,
): ClawInstallSchemaVersionSnapshot {
  if (snapshot) {
    return snapshot;
  }
  const previousAgentIds = knownAgentIds(previous);
  return previousAgentIds.size > 0 || (previous !== undefined && isOwnershipUnknown(previous))
    ? {
        kind: "state-error",
        error: new Error("OpenClaw state database disappeared after Claw ownership was observed."),
        knownAgentIds: previousAgentIds,
        ownershipUnknown: true,
      }
    : { kind: "ready", schemaVersions: new Map() };
}

export async function prepareClawInstallSchemaVersions(
  options: OpenClawStateDatabaseOptions = {},
): Promise<{ path: string; publish: () => void }> {
  const path = resolveSnapshotPath(options);
  const previous = snapshotsByPath.get(path);
  let snapshot: ClawInstallSchemaVersionSnapshot;
  let assertCurrent: (() => void) | undefined;
  try {
    const context = captureOpenClawStateWorkerContext({ path, env: options.env });
    assertCurrent = context.admission.assertCurrent;
    const rows = await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "claws.install-schema-versions",
          input: undefined,
        }),
      { existingOnly: true },
    );
    snapshot = resolveSchemaVersionSnapshot(
      rows === undefined ? undefined : decodeSchemaVersions(rows),
      previous,
    );
  } catch (error) {
    snapshot = {
      kind: "state-error",
      error,
      knownAgentIds: knownAgentIds(previous),
      ownershipUnknown: true,
    };
  }
  return {
    path,
    publish: () => {
      const current = snapshotsByPath.get(path);
      // Lifecycle changes and committed Claw writes supersede the staged read.
      if (current !== previous) {
        return;
      }
      try {
        if (resolveSnapshotPath(options) !== path) {
          throw new Error("OpenClaw state location changed before consent provenance publication.");
        }
        assertCurrent?.();
      } catch (error) {
        snapshot = {
          kind: "state-error",
          error,
          knownAgentIds: knownAgentIds(current),
          ownershipUnknown: true,
        };
      }
      snapshotsByPath.set(path, snapshot);
      notifySnapshotListeners();
    },
  };
}

export function registerClawInstallSchemaVersionSnapshotListener(listener: () => void): () => void {
  snapshotListeners.add(listener);
  return () => snapshotListeners.delete(listener);
}

export function cacheClawInstallSchemaVersion(
  agentId: string,
  schemaVersion: ReturnType<typeof parseClawInstallRecordSchemaVersion>,
  agentConfigDigest: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const snapshot = snapshotsByPath.get(resolveSnapshotPath(options));
  if (snapshot?.kind !== "ready") {
    return;
  }
  snapshot.schemaVersions.set(agentId, { kind: "ok", schemaVersion, agentConfigDigest });
  snapshotsByPath.set(resolveSnapshotPath(options), { ...snapshot });
  notifySnapshotListeners();
}

export function deleteCachedClawInstallSchemaVersion(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const snapshot = snapshotsByPath.get(resolveSnapshotPath(options));
  if (snapshot?.kind !== "ready" || !snapshot.schemaVersions.delete(agentId)) {
    return;
  }
  snapshotsByPath.set(resolveSnapshotPath(options), { ...snapshot });
  notifySnapshotListeners();
}
