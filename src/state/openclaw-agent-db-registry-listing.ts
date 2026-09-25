import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { inspectDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
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
type AgentDatabaseRegistrySource = {
  agentId: string;
  path: string;
  physicalPath: string;
  identity: string;
  schemaVersion: number;
};

export type AgentDatabaseRegistryMutation = {
  kind: "upsert" | "remove";
  sources: readonly AgentDatabaseRegistrySource[];
};

type RegistryTransition = {
  operation: symbol;
  phase: "begin" | "commit" | "finish";
  mutation?: AgentDatabaseRegistryMutation;
};

type AgentDatabaseRegistryMemo = {
  pathname: string;
  token: symbol;
  entries?: readonly OpenClawRegisteredAgentDatabase[];
  next?: { memo: AgentDatabaseRegistryMemo; transition?: RegistryTransition };
};
// A plugin may first open a hot-created agent; its registration must invalidate
// native discovery even when subsequent callers reuse the shared connection.
const registry = resolveGlobalSingleton<{
  memo?: AgentDatabaseRegistryMemo;
  pending: Map<symbol, RegistryTransition & { pathname: string }>;
  publications: WeakSet<SessionRowChange>;
}>(Symbol.for("openclaw.agentDatabaseRegistryMemo"), () => ({
  pending: new Map(),
  publications: new WeakSet(),
}));

/** Registry facts retain their owner through deferred COMMIT publication. */
export function emitOpenClawAgentDatabaseRegistryChange(database?: DatabaseSync): void {
  const change: SessionRowChange = { all: true, scope: "stores" };
  registry.publications.add(change);
  sessionChanges.emit(change, database);
}

export function isOpenClawAgentDatabaseRegistryChange(change: SessionRowChange): boolean {
  return registry.publications.has(change);
}

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

export function invalidateRegisteredAgentDatabasesMemo(
  options: OpenClawStateDatabaseOptions,
): void {
  advanceRegisteredAgentDatabasesMemo(resolveAgentDatabaseRegistryPath(options));
}

function advanceRegisteredAgentDatabasesMemo(
  pathname: string,
  transition?: RegistryTransition,
): void {
  if (transition?.phase === "begin") {
    registry.pending.set(transition.operation, { ...transition, pathname });
  } else if (transition?.phase === "finish") {
    registry.pending.delete(transition.operation);
  }
  const previous = registry.memo;
  if (previous?.pathname !== pathname) {
    return;
  }
  const memo = { pathname, token: Symbol(pathname) };
  // Only captured readers retain older nodes; the owner never keeps a backward history.
  previous.next = { memo, transition };
  registry.memo = memo;
}

function captureRegistryMutation(
  kind: AgentDatabaseRegistryMutation["kind"],
  sources: readonly { agentId: string; path: string; schemaVersion?: number }[],
): AgentDatabaseRegistryMutation | undefined {
  try {
    const captured: AgentDatabaseRegistrySource[] = [];
    for (const source of sources) {
      const identity = inspectDatabasePathIdentitySync(source.path);
      if (!identity) {
        return undefined;
      }
      captured.push({
        agentId: source.agentId,
        path: path.resolve(source.path),
        physicalPath: identity.canonicalPath,
        identity: identity.key,
        schemaVersion: source.schemaVersion ?? OPENCLAW_AGENT_SCHEMA_VERSION,
      });
    }
    return { kind, sources: captured };
  } catch {
    // An uninspectable publication cannot certify an unrelated selection.
    return undefined;
  }
}

/** Stage exact registry facts at the same native transaction boundary as their rows. */
export function recordOpenClawAgentDatabaseRegistryMutation(
  database: { db: DatabaseSync; path: string },
  kind: AgentDatabaseRegistryMutation["kind"],
  sources: readonly { agentId: string; path: string; schemaVersion?: number }[],
): void {
  const operation = Symbol("agent-registry-mutation");
  const mutation = captureRegistryMutation(kind, sources);
  const advance = (phase: RegistryTransition["phase"]) =>
    advanceRegisteredAgentDatabasesMemo(database.path, { operation, mutation, phase });
  if (
    !stageSqliteTransactionState(database.db, {
      stage: () => advance("begin"),
      commit: () => {
        advance("commit");
        advance("finish");
      },
      rollback: () => advance("finish"),
    })
  ) {
    throw new Error("Registry mutation requires its canonical transaction publication scope");
  }
}

/** Publish only registration witnessed at COMMIT, under its original shared generation. */
export function captureOpenClawAgentDatabaseRegistration(params: {
  agentId: string;
  agentPath: string;
  admission: OpenClawStateDatabaseReadAdmission;
}) {
  const options = { path: params.admission.databasePath };
  const operation = Symbol("agent-registry-registration");
  const mutation = captureRegistryMutation("upsert", [
    { agentId: params.agentId, path: params.agentPath },
  ]);
  const advance = (phase: RegistryTransition["phase"]) =>
    advanceRegisteredAgentDatabasesMemo(options.path, { operation, mutation, phase });
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
        advance("begin");
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
      try {
        params.admission.assertCurrent();
      } catch (error) {
        if (isStateDatabaseReadAdmissionInvalidatedError(error)) {
          return;
        }
        throw error;
      }
      advance("commit");
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
      } finally {
        registry.pending.delete(operation);
      }
      if (active) {
        advance("finish");
      }
      if (committed) {
        emitOpenClawAgentDatabaseRegistryChange();
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

/** A captured discovery view changed; retrying does not conceal a storage read failure. */
class AgentDatabaseRegistryReadInvalidatedError extends Error {}

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
  if (memo.entries) {
    const entries = cloneRegisteredAgentDatabases(memo.entries);
    return options.includeIncompatibleSchemaVersions
      ? entries
      : entries.filter((entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION);
  }
  // Discovery runs per row in list hot paths, so the legacy-schema gate and the
  // query share one process-held state handle instead of opening two connections.
  const entries = readRegisteredAgentDatabases(
    { ...options, includeIncompatibleSchemaVersions: true },
    false,
  );
  memo.entries = entries;
  const cloned = cloneRegisteredAgentDatabases(entries);
  return options.includeIncompatibleSchemaVersions
    ? cloned
    : cloned.filter((entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION);
}

/** Scoped publication witnesses are immediate; native registry rows remain demand-driven. */
export function prepareOpenClawAgentDatabaseRegistrySnapshotRead(
  inputOptions: AgentDatabaseRegistryListOptions = {},
  unchangedBy?: (
    mutation: AgentDatabaseRegistryMutation,
    entries: readonly OpenClawRegisteredAgentDatabase[] | undefined,
  ) => boolean,
): {
  assertCurrent: () => void;
  read(): Promise<{
    result: OpenClawAgentDatabaseRegistryReadResult;
    assertCurrent: () => void;
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
    const captureWitness = () => {
      const memo = activateRegisteredAgentDatabasesMemo(options);
      let cursor = memo;
      let referenceEntries = memo.entries;
      const unchanged = (mutation: AgentDatabaseRegistryMutation | undefined) => {
        if (!mutation || !unchangedBy) {
          return false;
        }
        return unchangedBy(mutation, referenceEntries);
      };
      const assertCurrent = () => {
        context.admission.assertCurrent();
        const current = registry.memo;
        if (
          unchangedBy &&
          [...registry.pending.values()].some(
            (pending) => pending.pathname === options.path && !unchanged(pending.mutation),
          )
        ) {
          throw new AgentDatabaseRegistryReadInvalidatedError(
            "Agent database registry ownership is changing during discovery",
          );
        }
        while (cursor !== current) {
          const next = cursor.next;
          if (
            !unchangedBy ||
            !next?.transition ||
            (next.transition.phase === "commit" && !unchanged(next.transition.mutation))
          ) {
            throw new AgentDatabaseRegistryReadInvalidatedError(
              "Agent database registry changed during discovery; retry the read.",
            );
          }
          cursor = next.memo;
        }
      };
      return {
        memo,
        assertCurrent,
        acceptEntries(entries: readonly OpenClawRegisteredAgentDatabase[]) {
          referenceEntries = entries;
        },
      };
    };
    // Scoped readers retain publication authority even when native discovery needs no registry rows.
    const scopedWitness = unchangedBy ? captureWitness() : undefined;
    let assertPreparedCurrent =
      scopedWitness?.assertCurrent ?? (() => context.admission.assertCurrent());
    return {
      assertCurrent: () => assertPreparedCurrent(),
      async read() {
        context.admission.assertCurrent();
        const witness = scopedWitness ?? captureWitness();
        const { memo, assertCurrent } = witness;
        // Install the witness before the first await, including a read that later rejects.
        assertPreparedCurrent = assertCurrent;
        assertCurrent();
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
          witness.acceptEntries(result?.status === "available" ? result.entries : []);
          assertCurrent();
          if (
            result?.status === "unavailable" ||
            (result === undefined && hasUnavailableMissingSqlitePath(options.path))
          ) {
            return { result: { status: "unavailable" }, assertCurrent };
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
