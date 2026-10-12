import { fork } from "node:child_process";
import type { FileIdentityStat } from "@openclaw/fs-safe/advanced";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
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
  const startReader = (timeoutMs: number): ReaderProcess => {
    const entry = resolveRuntimeProcessEntrypointUrl("agentSchemaInspection");
    const child = fork(entry, [], {
      execArgv: resolveRuntimeWorkerArgv(entry).slice(0, -1),
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    processCount += 1;
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
        if (
          kind !== "state" &&
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
            validation?.schema?.facts.userVersion === input.supportedVersion &&
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
              if (!stateInspection) {
                failure = new Error("Invalid state schema inspection response");
                kill();
                return;
              }
              response.resolve({
                ...stateInspection,
                schemaContracts: message.schemaContracts,
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
              : (failure ??
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
            { type: kind === "state" ? "inspect-state" : "inspect", requestId, input, snapshot },
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
    ): Promise<StateSchemaInspection> => {
      const result = await operations.inspect({ kind: "state", input }, callerSignal, snapshotPath);
      if (!result || !("schemas" in result)) {
        throw new Error("Missing state schema inspection result");
      }
      return result;
    },
    async [Symbol.asyncDispose]() {
      disposed = true;
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
