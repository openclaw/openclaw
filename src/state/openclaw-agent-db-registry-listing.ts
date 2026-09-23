import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabaseRegistryReadResult,
  type OpenClawAgentDatabaseRegistrationCommit,
  type OpenClawRegisteredAgentDatabase,
} from "./openclaw-agent-db-contract.js";
import { readRegisteredAgentDatabaseRows } from "./openclaw-agent-db-registry.read.js";
import {
  isStateDatabaseReadAdmissionInvalidatedError,
  type OpenClawStateDatabaseReadAdmission,
} from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
  withExistingOpenClawStateDatabaseReadOnly,
  executeExistingOpenClawStateRead,
} from "./openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
// Registry metadata is process-stable: registry writes invalidate after each commit;
// other-process changes take effect on restart. Polling here puts schema probes back on hot reads.
type AgentDatabaseRegistryMemo = {
  pathname: string;
  token: symbol;
  entries?: readonly OpenClawRegisteredAgentDatabase[];
};

// A plugin may first open a hot-created agent; its registration must invalidate
// native discovery even when subsequent callers reuse the shared connection.
const registry = resolveGlobalSingleton<{ memo?: AgentDatabaseRegistryMemo }>(
  Symbol.for("openclaw.agentDatabaseRegistryMemo"),
  () => ({}),
);

function resolveAgentDatabaseRegistryPath(options: OpenClawStateDatabaseOptions): string {
  return path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));
}

function activateRegisteredAgentDatabasesMemo(
  options: OpenClawStateDatabaseOptions,
): AgentDatabaseRegistryMemo {
  const pathname = resolveAgentDatabaseRegistryPath(options);
  if (registry.memo?.pathname !== pathname) {
    // One active pathname keeps registry metadata process-stable without retaining
    // an unbounded generation map. Switching back creates a fresh generation.
    registry.memo = { pathname, token: Symbol(pathname) };
  }
  return registry.memo;
}

/** Return the process-stable generation for the active agent database registry. */
export function readOpenClawAgentDatabaseRegistryToken(
  options: OpenClawStateDatabaseOptions = {},
): symbol {
  return activateRegisteredAgentDatabasesMemo(options).token;
}

/** An in-process witness from the canonical invalidator, never serialized as authority. */
export type AgentDatabaseRegistryChange = Readonly<{ previous: symbol; current: symbol }>;

export function invalidateRegisteredAgentDatabasesMemo(
  options: OpenClawStateDatabaseOptions,
): AgentDatabaseRegistryChange | undefined {
  const pathname = resolveAgentDatabaseRegistryPath(options);
  if (registry.memo?.pathname === pathname) {
    const previous = registry.memo.token;
    registry.memo = { pathname, token: Symbol(pathname) };
    return { previous, current: registry.memo.token };
  }
  return undefined;
}

/** Publish only registration witnessed at COMMIT, under its original shared generation. */
export function captureOpenClawAgentDatabaseRegistration(params: {
  agentId: string;
  agentPath: string;
  admission: OpenClawStateDatabaseReadAdmission;
  onRegistryChange?: (change: AgentDatabaseRegistryChange) => void;
}) {
  const options = { path: params.admission.databasePath };
  let active = false;
  let committed = false;
  let finished = false;
  return {
    begin() {
      if (finished) {
        throw new Error("Agent database registration admission is closed");
      }
      if (!active) {
        active = true;
        const change = invalidateRegisteredAgentDatabasesMemo(options);
        if (change) {
          params.onRegistryChange?.(change);
        }
      }
    },
    recordCommitted(receipt: OpenClawAgentDatabaseRegistrationCommit) {
      if (
        finished ||
        !active ||
        receipt.agentId !== params.agentId ||
        receipt.agentPath !== params.agentPath ||
        receipt.stateDatabasePath !== params.admission.databasePath ||
        receipt.stateDatabaseIdentity !== params.admission.identity.key
      ) {
        throw new Error("Agent registration commit differs from its captured owner");
      }
      committed = true;
    },
    finish() {
      if (finished) {
        return;
      }
      finished = true;
      try {
        params.admission.assertCurrent();
      } catch (error) {
        if (isStateDatabaseReadAdmissionInvalidatedError(error)) {
          return;
        }
        throw error;
      }
      try {
        const change = active ? invalidateRegisteredAgentDatabasesMemo(options) : undefined;
        if (change) {
          params.onRegistryChange?.(change);
        }
      } finally {
        if (committed) {
          sessionChanges.emit({ all: true, scope: "stores" });
        }
      }
    },
  };
}

function cloneRegisteredAgentDatabases(
  entries: readonly OpenClawRegisteredAgentDatabase[],
): OpenClawRegisteredAgentDatabase[] {
  return entries.map((entry) => ({ ...entry }));
}

function hasUnavailableMissingSqlitePath(pathname: string): boolean {
  for (const candidate of resolveSqliteDatabaseFilePaths(pathname)) {
    try {
      lstatSync(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return true;
      }
    }
  }

  let ancestor = path.dirname(pathname);
  while (true) {
    try {
      const stat = lstatSync(ancestor);
      if (!stat.isSymbolicLink()) {
        return !stat.isDirectory();
      }
      try {
        return !statSync(ancestor).isDirectory();
      } catch {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return true;
      }
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      return false;
    }
    ancestor = parent;
  }
}

type AgentDatabaseRegistryListOptions = OpenClawStateDatabaseOptions & {
  includeIncompatibleSchemaVersions?: boolean;
};

export class AgentDatabaseRegistryChangedError extends Error {
  constructor() {
    super("Agent database registry changed during discovery; retry the read.");
    this.name = "AgentDatabaseRegistryChangedError";
  }
}

export function readRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions,
  artifactPreserving: false,
): OpenClawRegisteredAgentDatabase[];
export function readRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions,
  artifactPreserving: true,
): Promise<OpenClawRegisteredAgentDatabase[]>;
export function readRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions,
  artifactPreserving: boolean,
): OpenClawRegisteredAgentDatabase[] | Promise<OpenClawRegisteredAgentDatabase[]> {
  const pathname = resolveAgentDatabaseRegistryPath(options);
  const read = ({ db }: { db: DatabaseSync }) =>
    readRegisteredAgentDatabaseRows(db, pathname, artifactPreserving);
  const finish = (entries: OpenClawRegisteredAgentDatabase[] | undefined) => {
    if (entries === undefined) {
      if (hasUnavailableMissingSqlitePath(pathname)) {
        throw new Error(`OpenClaw state database ${pathname} is unavailable.`);
      }
      return [];
    }
    return options.includeIncompatibleSchemaVersions
      ? entries
      : entries.filter((entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION);
  };
  return artifactPreserving
    ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(read, options).then(finish)
    : finish(withExistingOpenClawStateDatabaseReadOnly(read, options));
}

/** Inspect a copied registry without creating SQLite artifacts or runtime memo state. */
export async function inspectOpenClawRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions = {},
): Promise<OpenClawRegisteredAgentDatabase[]> {
  return readRegisteredAgentDatabases(options, true);
}

/** List agent databases recorded in the shared OpenClaw state registry. */
export function listOpenClawRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions = {},
): OpenClawRegisteredAgentDatabase[] {
  const memo = activateRegisteredAgentDatabasesMemo(options);
  // Discovery runs per row in list hot paths, so the legacy-schema gate and the
  // query share one process-held state handle instead of opening two connections.
  const entries = (memo.entries ??= readRegisteredAgentDatabases(
    { ...options, includeIncompatibleSchemaVersions: true },
    false,
  ));
  const cloned = cloneRegisteredAgentDatabases(entries);
  return options.includeIncompatibleSchemaVersions
    ? cloned
    : cloned.filter((entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION);
}

/** Capture authority now, but activate the canonical memo only if discovery needs it. */
export function prepareOpenClawAgentDatabaseRegistrySnapshotRead(
  inputOptions: AgentDatabaseRegistryListOptions = {},
): {
  assertCurrent: () => void;
  read(): Promise<{
    result: OpenClawAgentDatabaseRegistryReadResult;
    assertCurrent: () => void;
    followRegistration: (change: AgentDatabaseRegistryChange) => void;
  }>;
} {
  try {
    const env = cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env);
    env.OPENCLAW_STATE_DIR = resolveStateDir(env);
    const options = {
      ...inputOptions,
      env,
      path: resolveAgentDatabaseRegistryPath({ ...inputOptions, env }),
    };
    const context = captureOpenClawStateWorkerContext(options);
    const inCapturedScope = AsyncLocalStorage.snapshot();
    let assertPreparedCurrent = () => context.admission.assertCurrent();
    return {
      assertCurrent: () => assertPreparedCurrent(),
      async read() {
        context.admission.assertCurrent();
        let memo = activateRegisteredAgentDatabasesMemo(options);
        let invalidated = false;
        const assertCurrent = () => {
          context.admission.assertCurrent();
          if (invalidated || registry.memo !== memo) {
            invalidated = true;
            throw new AgentDatabaseRegistryChangedError();
          }
        };
        const followRegistration = (change: AgentDatabaseRegistryChange) => {
          context.admission.assertCurrent();
          if (
            invalidated ||
            memo.token !== change.previous ||
            registry.memo?.pathname !== memo.pathname ||
            registry.memo.token !== change.current
          ) {
            invalidated = true;
            throw new Error("Agent registration cannot replace an invalidated registry read");
          }
          memo = registry.memo;
        };
        // Install the witness before the first await, including a read that later rejects.
        assertPreparedCurrent = assertCurrent;
        if (!memo.entries) {
          const reply = await inCapturedScope(() =>
            withStateDatabaseCoordinatorRuntimeDirectory(context.coordinatorRuntime, () =>
              executeExistingOpenClawStateRead(options, { type: "agentDatabaseRegistry.read" }),
            ),
          );
          if (reply && (!reply.ok || reply.type !== "agentDatabaseRegistry.read")) {
            throw new Error("Unexpected agent database registry read result");
          }
          const result = reply?.result;
          assertCurrent();
          if (
            result?.status === "unavailable" ||
            (result === undefined && hasUnavailableMissingSqlitePath(options.path))
          ) {
            return { result: { status: "unavailable" }, assertCurrent, followRegistration };
          }
          memo.entries ??= result?.entries ?? [];
        }
        const entries = cloneRegisteredAgentDatabases(memo.entries);
        assertCurrent();
        return {
          result: {
            status: "available",
            entries: options.includeIncompatibleSchemaVersions
              ? entries
              : entries.filter((entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION),
          },
          assertCurrent,
          followRegistration,
        };
      },
    };
  } catch (error) {
    return {
      assertCurrent() {
        throw error;
      },
      async read() {
        throw error;
      },
    };
  }
}
