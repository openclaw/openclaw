import { fork } from "node:child_process";
import type { FileIdentityStat } from "@openclaw/fs-safe/advanced";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { z } from "zod";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { readSqliteIntegrityFileIdentity } from "../infra/sqlite-file-generation.js";
import {
  isSqliteInspectionDeadlineOwnedByCaller,
  readSqliteInspectionBudget,
  resolveSqliteInspectionSignal,
  sqliteInspectionTimeoutError,
} from "../infra/sqlite-readonly-worker.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  agentSchemaInspectionErrorSchema,
  restoreAgentSchemaInspectionError,
} from "./openclaw-agent-schema-inspection-response.js";
import type {
  AgentSchemaInspection,
  AgentSchemaInspectionInput,
} from "./openclaw-agent-schema-inspection.js";
import type {
  StateSchemaInspection,
  StateSchemaInspectionInput,
} from "./openclaw-state-schema-preflight.js";

const stateSchemaRow = z.object({
  kind: z.literal("state"),
  path: z.string(),
  foundVersion: z.number(),
  supportedVersion: z.number(),
  writerAppVersion: z.string().optional(),
});
const deletionFacts = z.object({
  entries: z.array(
    z.object({ agentId: z.string(), agentDir: z.string(), databasePaths: z.array(z.string()) }),
  ),
  held: z.array(z.object({ agentId: z.string(), path: z.string() })),
});
const schemaContract = z.object({
  schemaSql: z.string(),
  tables: z.map(
    z.string(),
    z.object({
      definition: z
        .object({ columns: z.map(z.string(), z.string()), constraints: z.array(z.string()) })
        .nullable(),
      indexes: z.array(
        z.object({
          name: z.string().nullable(),
          origin: z.string(),
          partial: z.number(),
          sql: z.string().nullable(),
          terms: z.array(
            // Canonical index fingerprints serialize the assembly owner's field order.
            z.object({
              coll: z.string(),
              desc: z.number(),
              key: z.number(),
              kind: z.enum(["column", "expression", "rowid"]),
              name: z.string().nullable(),
              seqno: z.number(),
            }),
          ),
          unique: z.number(),
        }),
      ),
      strict: z.number(),
      triggers: z.array(z.object({ name: z.string(), sql: z.string().nullable() })),
      virtualTableSql: z.string().nullable(),
      withoutRowid: z.number(),
    }),
  ),
});
const stateInspectionSchema = z.object({
  schemas: z.object({
    incompatible: z.array(stateSchemaRow),
    indeterminate: z.array(
      z.object({ kind: z.literal("state"), path: z.string(), reason: z.string() }),
    ),
    pendingMigrations: z.array(stateSchemaRow).optional(),
    deferredSchemaPublications: z
      .array(
        z.object({
          kind: z.literal("state"),
          path: z.string(),
          foundVersion: z.number(),
          contentVersion: z.number(),
          runId: z.string().optional(),
          publishAfterMs: z.number().nullable().optional(),
          message: z.string(),
        }),
      )
      .optional(),
  }),
  registeredDatabases: z.array(z.object({ agentId: z.string(), path: z.string() })).optional(),
  deletionJournal: z
    .discriminatedUnion("status", [
      z.object({ status: z.literal("empty") }),
      deletionFacts.extend({ status: z.literal("present") }),
      z.object({
        status: z.literal("unavailable"),
        cause: z.enum(["missing", "unreadable"]),
        reason: z.string(),
        known: deletionFacts.optional(),
      }),
    ])
    .optional(),
  inspectionErrors: z.array(agentSchemaInspectionErrorSchema),
});

const inspectionResponse = z.discriminatedUnion("ok", [
  z.object({
    requestId: z.number().int().safe(),
    ok: z.literal(false),
    error: agentSchemaInspectionErrorSchema,
  }),
  z.object({
    requestId: z.number().int().safe(),
    ok: z.literal(true),
    stateInspection: stateInspectionSchema.optional(),
    schemaContracts: z.array(schemaContract).optional(),
    inspection: z
      .object({
        version: z.number().int().safe(),
        integrityGateOutcome: z.enum(["cached", "healthy"]).optional(),
        preparationPending: z.literal(true).optional(),
        writerAppVersion: z.string().optional(),
        reason: z.string().optional(),
        failure: agentSchemaInspectionErrorSchema.optional(),
        agentSchemaMeta: z
          .object({
            agentId: z.string().nullable(),
            role: z.string().nullable(),
            schemaVersion: z.number().nullable(),
          })
          .nullable()
          .optional(),
      })
      .nullable(),
  }),
]);

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
      input: AgentSchemaInspectionInput | StateSchemaInspectionInput,
      callerSignal?: AbortSignal,
      snapshotPath?: string,
      kind?: "state",
    ): Promise<AgentSchemaInspection | StateSchemaInspection | null> => {
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
        const onMessage = (message: unknown) => {
          if (failure) {
            return;
          }
          const parsed = inspectionResponse.safeParse(message);
          if (!parsed.success || parsed.data.requestId !== requestId) {
            failure = new Error("Invalid agent schema inspection response");
            kill();
          } else if (!parsed.data.ok) {
            failure = restoreAgentSchemaInspectionError(parsed.data.error);
            // Failed native close can retain a handle and its lease until child exit.
            retireReader(active);
          } else {
            if (kind === "state") {
              const stateInspection = parsed.data.stateInspection;
              if (!stateInspection) {
                failure = new Error("Invalid state schema inspection response");
                kill();
                return;
              }
              response.resolve({
                ...stateInspection,
                schemaContracts: parsed.data.schemaContracts,
                inspectionErrors: stateInspection.inspectionErrors.map(
                  restoreAgentSchemaInspectionError,
                ),
              });
              return;
            }
            const inspection = parsed.data.inspection;
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
      const result = await operations.inspect(input, callerSignal, snapshotPath);
      if (result && "schemas" in result) {
        throw new Error("Unexpected state schema inspection result");
      }
      return result;
    },
    inspectState: async (
      input: StateSchemaInspectionInput,
      callerSignal: AbortSignal | undefined,
      snapshotPath: string,
    ): Promise<StateSchemaInspection> => {
      const result = await operations.inspect(input, callerSignal, snapshotPath, "state");
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
