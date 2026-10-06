import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawStateIntegrityAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";

/** Resolved host facts for the canonical shared-state owner, never authority. */
export type SqliteWorkerStateContext = {
  environment: NodeJS.ProcessEnv & {
    OPENCLAW_STATE_DIR: string;
    OPENCLAW_SUPERVISOR_MODE?: "external";
  };
  /** Selected config inputs for native shared-state initialization, not command environment. */
  initializationEnvironment?: NodeJS.ProcessEnv;
  /** Known agent paths preserve deletion-history uncertainty during native initialization. */
  initializationAgentPaths?: readonly string[];
  existingSchemaPath?: string;
  stateIntegrity?: OpenClawStateIntegrityAdmission;
};

export function captureSqliteWorkerStateContext(
  context: SqliteWorkerStateContext,
): SqliteWorkerStateContext {
  return {
    environment: { ...context.environment },
    ...(context.initializationEnvironment
      ? { initializationEnvironment: { ...context.initializationEnvironment } }
      : {}),
    ...(context.initializationAgentPaths
      ? { initializationAgentPaths: [...context.initializationAgentPaths] }
      : {}),
    existingSchemaPath: context.existingSchemaPath,
    stateIntegrity: context.stateIntegrity,
  };
}

/** Charge captured initialization facts together with the request bytes retained by admission. */
export function sqliteWorkerRequestBytes(
  input: Uint8Array,
  context?: SqliteWorkerStateContext,
  preparation?: Uint8Array,
): number {
  const agentPathBytes =
    context?.initializationAgentPaths?.reduce(
      (bytes, agentPath) => bytes + Buffer.byteLength(agentPath, "utf8"),
      0,
    ) ?? 0;
  return [context?.environment, context?.initializationEnvironment].reduce(
    (bytes, environment) =>
      Object.entries(environment ?? {}).reduce(
        (total, [key, value]) =>
          total + Buffer.byteLength(key, "utf8") + Buffer.byteLength(value ?? "", "utf8"),
        bytes,
      ),
    input.byteLength + (preparation?.byteLength ?? 0) + agentPathBytes,
  );
}

// Source hosts and built backends can load separate module copies in one Worker.
const stateContexts = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerStateContext"),
  () =>
    new AsyncLocalStorage<
      SqliteWorkerStateContext & {
        existingDatabase?: { databasePath: string; identity: string };
      }
    >(),
);

/** Preserve factory facts across later commands without changing their captured host context. */
export function withSqliteWorkerExistingDatabase<T>(
  databasePath: string,
  identity: string,
  operation: () => T,
): T {
  return stateContexts.run(
    {
      ...getSqliteWorkerStateContext(),
      existingDatabase: { databasePath, identity },
    },
    operation,
  );
}

/** Only cold writable opens need this factory's prior-existence constraint. */
export function getSqliteWorkerExistingDatabaseIdentity(databasePath: string): string | undefined {
  const existing = stateContexts.getStore()?.existingDatabase;
  return existing?.databasePath === databasePath ? existing.identity : undefined;
}

export function getSqliteWorkerStateIntegrityAdmission():
  | OpenClawStateIntegrityAdmission
  | undefined {
  return stateContexts.getStore()?.stateIntegrity;
}

export function runWithSqliteWorkerStateContext<T>(
  context: SqliteWorkerStateContext,
  operation: () => T,
): T {
  return stateContexts.run(context, () =>
    context.existingSchemaPath === undefined
      ? operation()
      : withExistingOpenClawStateSchema({ path: context.existingSchemaPath }, operation),
  );
}

export function getSqliteWorkerStateContext(): SqliteWorkerStateContext {
  const context = stateContexts.getStore();
  if (!context) {
    throw new Error("Shared-state SQLite requires captured host context");
  }
  return context;
}
