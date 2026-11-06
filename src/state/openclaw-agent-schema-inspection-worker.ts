import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import type { FileIdentityStat } from "@openclaw/fs-safe/advanced";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import {
  assertChildRuntimeAvailable,
  observeChildRuntime,
} from "../infra/child-runtime-viability.js";
import {
  getDatabaseEngineInput,
  getDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import {
  getOrLoadSqliteDatabaseAdmissionForPath,
  prepareSqliteDatabaseAdmission,
  readSqliteDatabaseCleanClose,
} from "../infra/sqlite-database-admission.js";
import { readSqliteIntegrityFileIdentity } from "../infra/sqlite-file-generation.js";
import {
  isSqliteInspectionDeadlineOwnedByCaller,
  readSqliteInspectionBudget,
  resolveSqliteInspectionSignal,
  sqliteInspectionTimeoutError,
} from "../infra/sqlite-readonly-worker.js";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { createDeferredCore } from "../shared/deferred.js";
import { agentSchemaMetadataKey } from "./openclaw-agent-db-metadata.js";
import { agentDatabaseValidationKey } from "./openclaw-agent-db-validation-facts.js";
import {
  restoreAgentSchemaInspectionError,
  type AgentSchemaInspectionResponse,
} from "./openclaw-agent-schema-inspection-response.js";
import type {
  AgentSchemaInspection,
  AgentSchemaInspectionInput,
} from "./openclaw-agent-schema-inspection.js";
import type {
  StateSchemaInspection,
  StateSchemaInspectionInput,
} from "./openclaw-state-schema-preflight.js";

type ReaderProcess = {
  child: ReturnType<typeof fork>;
  closed: Promise<void>;
  retired: boolean;
  closeBudgetMs: number;
  failure?: Error;
  runtimeFailure?: Error;
};

export type AgentSchemaInspectionSnapshot = { pathname: string; identity: FileIdentityStat };

function retireReader(reader: ReaderProcess): void {
  if (reader.retired) {
    return;
  }
  reader.retired = true;
  if (reader.child.connected) {
    // Child-initiated IPC shutdown preserves the parent's close event on Node 26.
    reader.child.send({ type: "close" }, (error) => {
      if (error) {
        reader.child.kill("SIGKILL");
      }
    });
  }
}

/** One scheduler slot reuses imports and canonical schema contracts, never database reads. */
export function createAgentSchemaInspectionWorker() {
  let reader: ReaderProcess | undefined;
  let disposed = false;
  let busy = false;
  let processCount = 0;
  let inspectionCount = 0;
  let snapshotCount = 0;
  let sequence = 0;
  let releasePrestart: (() => void) | undefined;
  const startReader = (timeoutMs: number): ReaderProcess => {
    const entry = resolveRuntimeProcessEntrypointUrl("agentSchemaInspection");
    assertChildRuntimeAvailable();
    const child = fork(entry, [], {
      execArgv: resolveRuntimeWorkerArgv(entry).slice(0, -1),
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    processCount += 1;
    const runtimeFailure = observeChildRuntime(child);
    const closed = createDeferredCore();
    const started: ReaderProcess = {
      child,
      closed: closed.promise,
      retired: false,
      closeBudgetMs: timeoutMs,
    };
    child.on("error", (error) => {
      started.failure ??= error;
      retireReader(started);
    });
    child.once("close", () => {
      started.runtimeFailure = runtimeFailure();
      started.retired = true;
      closed.resolve();
    });
    return started;
  };
  const operations = {
    inspect: async (
      request:
        | { kind: "agent"; input: AgentSchemaInspectionInput }
        | { kind: "state"; input: StateSchemaInspectionInput },
      callerSignal?: AbortSignal,
      snapshotPath?: string,
    ): Promise<AgentSchemaInspection | StateSchemaInspection | null> => {
      const { input, kind } = request;
      const signal = resolveSqliteInspectionSignal(callerSignal);
      signal?.throwIfAborted();
      if (disposed || busy) {
        throw new Error(
          disposed
            ? "Agent schema inspection worker is closed"
            : "Agent schema inspection worker is busy",
        );
      }
      busy = true;
      try {
        const schemaOnly =
          kind === "agent" &&
          !input.verifyCurrentSchemaShape &&
          !input.requireStartupMigrationReadiness &&
          !input.inspectEmptyStore;
        let postgresAgent = Boolean(getDatabaseEngineInput("agent"));
        let postgresAgentId: string | undefined;
        const selection = getDatabaseEngineSelection();
        if (schemaOnly && selection?.postgres) {
          // Update admission includes retained stores that can differ from the selected engine.
          if (!existsSync(snapshotPath ?? input.pathname)) {
            return null;
          }
          const { readBackupEngine, readBackupEngineImage } =
            await import("../infra/database-engine/physical-store.js");
          const physical = snapshotPath
            ? readBackupEngineImage(snapshotPath, input.pathname)
            : readBackupEngine(input.pathname);
          signal?.throwIfAborted();
          if (physical.engine === "sqlite") {
            if (postgresAgent && !snapshotPath) {
              // The caller assumed PostgreSQL; defer to its artifact-preserving SQLite copy.
              return null;
            }
            postgresAgent = false;
          } else {
            // Admission reads the server version; a runtime open could demand migration custody.
            const { withPostgresStoreMetadata } =
              await import("../infra/database-engine/postgres-store-metadata.js");
            const result = await withPostgresStoreMetadata(
              selection.postgres,
              physical,
              async (client, metadata) => {
                if (metadata.store !== "agent") {
                  throw new Error("PostgreSQL agent inspection requires an agent store.");
                }
                if (!input.inspectOwnership) {
                  return { version: metadata.version };
                }
                const { rows } = await client.query<{
                  agent_id: string | null;
                  role: string | null;
                  schema_version: number | null;
                }>(`SELECT agent_id, role, schema_version::integer AS schema_version
                    FROM ${quoteSqliteIdentifier(physical.namespace)}.schema_meta WHERE meta_key = 'primary'`);
                const row = rows[0];
                return {
                  version: metadata.version,
                  agentSchemaMeta: row
                    ? {
                        agentId: normalizeNullableString(row.agent_id),
                        role: row.role,
                        schemaVersion: row.schema_version,
                      }
                    : null,
                };
              },
            );
            signal?.throwIfAborted();
            inspectionCount += 1;
            return result;
          }
        }
        if (kind === "agent" && postgresAgent) {
          if (snapshotPath) {
            throw new Error(
              "PostgreSQL agent inspection requires its live engine owner, not a SQLite snapshot.",
            );
          }
          const { getPendingOpenClawAgentDatabasePreparation } =
            await import("./openclaw-agent-execution.js");
          await getPendingOpenClawAgentDatabasePreparation(input.pathname);
          signal?.throwIfAborted();
          let agentId =
            input.agentId ??
            getOrLoadSqliteDatabaseAdmissionForPath(
              input.pathname,
              agentSchemaMetadataKey,
              () => undefined,
            )?.agentId;
          if (!agentId) {
            const { prepareSqliteTargetFromSessionStorePath } =
              await import("../config/sessions/session-sqlite-target.js");
            const target = await prepareSqliteTargetFromSessionStorePath(
              input.pathname,
              { env: input.env ?? process.env },
              signal,
            );
            if (
              !target.agentId ||
              (target.ownerSource !== undefined &&
                target.ownerSource !== "database-path" &&
                target.ownerSource !== "database-registry")
            ) {
              throw new Error(
                "PostgreSQL schema inspection could not establish the custom store owner.",
              );
            }
            agentId = target.agentId;
          }
          postgresAgentId = agentId;
        }
        if (
          kind !== "state" &&
          !postgresAgent &&
          !snapshotPath &&
          input.requireStartupMigrationReadiness &&
          readSqliteDatabaseCleanClose(input.pathname)
        ) {
          const validation = getOrLoadSqliteDatabaseAdmissionForPath(
            input.pathname,
            agentDatabaseValidationKey,
            () => undefined,
          );
          const metadata = getOrLoadSqliteDatabaseAdmissionForPath(
            input.pathname,
            agentSchemaMetadataKey,
            () => undefined,
          );
          if (
            validation?.schema?.facts?.userVersion === input.supportedVersion &&
            Atomics.load(new Int32Array(validation.valid), 0) === 1 &&
            Atomics.load(new Int32Array(validation.schema.valid), 0) === 1 &&
            prepareSqliteDatabaseAdmission(input.pathname) ===
              `${validation.identity}:${validation.birthtime}` &&
            metadata?.agentId === validation.agentId &&
            (input.agentId === undefined || input.agentId === validation.agentId) &&
            metadata.role === "agent" &&
            metadata.schemaVersion === input.supportedVersion
          ) {
            return {
              version: input.supportedVersion,
              integrityGateOutcome: "cached",
              agentSchemaMeta: metadata,
            };
          }
        }
        const snapshot = snapshotPath
          ? { pathname: snapshotPath, identity: readSqliteIntegrityFileIdentity(snapshotPath) }
          : undefined;
        if (reader?.retired) {
          await reader.closed;
          reader = undefined;
        }
        signal?.throwIfAborted();
        if (disposed) {
          throw new Error("Agent schema inspection worker is closed");
        }
        const { timeoutMs, size } = readSqliteInspectionBudget(
          input.requireStartupMigrationReadiness ? "startup readiness" : "schema inspection",
          input.pathname,
        );
        const active = (reader ??= startReader(timeoutMs));
        active.closeBudgetMs = timeoutMs;
        releasePrestart?.();
        releasePrestart = undefined;
        const requestId = ++sequence;
        const response = createDeferredCore<AgentSchemaInspection | StateSchemaInspection | null>();
        let failure: Error | undefined;
        const kill = () => {
          active.retired = true;
          active.child.kill("SIGKILL");
        };
        const onAbort = () => {
          failure = toStringifiedError(signal?.reason);
          kill();
        };
        const onMessage = (message: AgentSchemaInspectionResponse) => {
          if (failure) {
            return;
          }
          if (message.requestId !== requestId) {
            failure = new Error("Invalid agent schema inspection response");
            kill();
          } else if (!message.ok) {
            failure = restoreAgentSchemaInspectionError(message.error);
            // Failed native close can retain a handle and its lease until child exit.
            retireReader(active);
          } else {
            if (kind === "state") {
              const stateInspection = message.stateInspection;
              if (stateInspection === null) {
                response.resolve(null);
                return;
              }
              if (stateInspection === undefined) {
                failure = new Error("Invalid state schema inspection response");
                kill();
                return;
              }
              response.resolve({
                ...stateInspection,
                inspectionErrors: stateInspection.inspectionErrors.map(
                  restoreAgentSchemaInspectionError,
                ),
              });
              return;
            }
            const inspection = message.inspection;
            response.resolve(
              inspection
                ? {
                    ...inspection,
                    failure: inspection.failure
                      ? restoreAgentSchemaInspectionError(inspection.failure)
                      : undefined,
                  }
                : null,
            );
          }
        };
        const onClose = (code: number | null, exitSignal: NodeJS.Signals | null) => {
          response.reject(
            signal?.aborted
              ? toStringifiedError(signal.reason)
              : (active.runtimeFailure ??
                  failure ??
                  active.failure ??
                  (exitSignal === "SIGKILL"
                    ? sqliteInspectionTimeoutError(
                        "schema inspection",
                        input.pathname,
                        timeoutMs,
                        size,
                      )
                    : new Error(
                        `Agent schema inspection exited ${code} without a completed result`,
                      ))),
          );
        };
        const timeout = isSqliteInspectionDeadlineOwnedByCaller()
          ? undefined
          : setTimeout(() => {
              failure ??= sqliteInspectionTimeoutError(
                "schema inspection",
                input.pathname,
                timeoutMs,
                size,
              );
              kill();
            }, timeoutMs);
        timeout?.unref();
        active.child.on("message", onMessage);
        active.child.once("close", onClose);
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          active.child.send(
            {
              type: kind === "state" ? "inspect-state" : "inspect",
              requestId,
              input: {
                ...input,
                ...(postgresAgentId ? { agentId: postgresAgentId } : {}),
                // Advanced IPC cannot clone the Windows case-insensitive env Proxy.
                ...("env" in input && input.env ? { env: { ...input.env } } : {}),
              },
              snapshot,
              ...(kind === "agent" && postgresAgent ? { databaseEngineSelection: selection } : {}),
            },
            (error) => {
              if (error) {
                failure ??= error;
                kill();
              }
            },
          );
          const result = await response.promise;
          if (signal?.aborted) {
            kill();
            await active.closed;
            throw toStringifiedError(signal.reason);
          }
          if (snapshot) {
            readSqliteIntegrityFileIdentity(snapshot.pathname, snapshot.identity);
          }
          if (result) {
            inspectionCount += 1;
            snapshotCount += snapshot ? 1 : 0;
          }
          return result;
        } finally {
          clearTimeout(timeout);
          active.child.off("message", onMessage);
          active.child.off("close", onClose);
          signal?.removeEventListener("abort", onAbort);
        }
      } finally {
        busy = false;
      }
    },
  };
  return {
    /** Load the isolated reader while startup discovers its targets; no database is opened. */
    prestart(callerSignal?: AbortSignal): void {
      const signal = resolveSqliteInspectionSignal(callerSignal);
      signal?.throwIfAborted();
      if (disposed || busy) {
        throw new Error("Agent schema inspection worker is unavailable for prestart");
      }
      if (reader) {
        return;
      }
      // An unused reader has no work to settle. Inspection installs its full budget below.
      const active = (reader = startReader(0));
      const onAbort = () => {
        active.retired = true;
        active.child.kill("SIGKILL");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const release = () => signal?.removeEventListener("abort", onAbort);
      releasePrestart = release;
      void active.closed.then(release);
    },
    get processCount() {
      return processCount;
    },
    get inspectionCount() {
      return inspectionCount;
    },
    get snapshotCount() {
      return snapshotCount;
    },
    inspect: async (
      input: AgentSchemaInspectionInput,
      callerSignal?: AbortSignal,
      snapshotPath?: string,
    ): Promise<AgentSchemaInspection | null> => {
      const result = await operations.inspect({ kind: "agent", input }, callerSignal, snapshotPath);
      if (result && "schemas" in result) {
        throw new Error("Unexpected state schema inspection result");
      }
      return result;
    },
    inspectState: async (
      input: StateSchemaInspectionInput,
      callerSignal: AbortSignal | undefined,
      snapshotPath?: string,
    ): Promise<StateSchemaInspection | null> => {
      const result = await operations.inspect({ kind: "state", input }, callerSignal, snapshotPath);
      if (result && !("schemas" in result)) {
        throw new Error("Unexpected agent schema inspection result");
      }
      return result;
    },
    async [Symbol.asyncDispose]() {
      disposed = true;
      releasePrestart?.();
      releasePrestart = undefined;
      if (!reader) {
        return;
      }
      const closing = reader;
      const timeout = setTimeout(() => closing.child.kill("SIGKILL"), closing.closeBudgetMs);
      timeout.unref();
      try {
        retireReader(closing);
        await closing.closed;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
