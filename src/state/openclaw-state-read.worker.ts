import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { getSqliteRuntimeCapabilities } from "../infra/bun-sqlite-library.js";
import {
  getDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { bunSqliteNativeCleanupPending } from "../infra/node-sqlite.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { withSqliteReaderOwner } from "../infra/sqlite-reader-lifecycle.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { serveOwnedWorkerTasks } from "../infra/worker-task-server.js";
import { pluginMetadataReadOperations } from "../plugins/plugin-metadata-state.read.worker.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  closeRetainedOpenClawStateReadConnections,
  openOpenClawStateReadConnection,
  readOpenClawStateReadOnlyLocation,
  withOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import { postgresStateReadSnapshot } from "./openclaw-state-postgres-snapshot-context.js";
import { stateReadRegistry } from "./openclaw-state-read-operation-registry.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

serveOwnedWorkerTasks(
  async function read(message, channel, control): Promise<OpenClawStateReadReply> {
    // SAFETY: Only the typed state-read pool sends requests on this private worker port.
    const input = message as OpenClawStateReadRequest;
    let sourceAdmitted: true | undefined;
    let nativeCleanupFailure: OpenClawStateReadReply["nativeCleanupFailure"];
    try {
      const leaseReader =
        input.command.type === "gatewayOwnerLease.read"
          ? await import("../infra/gateway-owner-lease.worker.js")
          : undefined;
      const dedicatedRead =
        input.command.type === "admit" ||
        input.command.type === "plugins.metadata.read" ||
        input.command.type === "gatewayOwnerLease.read";
      const prepared = dedicatedRead ? undefined : stateReadRegistry.prepare(input.command.type);
      if (prepared) {
        return prepared.then(() => read(input, channel, control));
      }
      const handlers =
        dedicatedRead || stateReadRegistry.has(input.command)
          ? undefined
          : await import("./openclaw-state-read-handlers.js");
      const executeRead = async (): Promise<OpenClawStateReadReply> => {
        if (input.checkFreshAdmission) {
          openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
            input.databasePath,
            input.context.environment,
            (error) => {
              nativeCleanupFailure = {
                error: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
              };
            },
          );
        }
        const { command } = input;
        if (command.type === "admit") {
          if (input.exportPostgresSnapshot) {
            if (!channel) {
              throw new Error("PostgreSQL discovery snapshot requires its retained receiver");
            }
            const connection = openOpenClawStateReadConnection(
              input.databasePath,
              input.location,
              input.expectedIdentity,
            );
            const db = connection.database.db;
            try {
              if (!isPostgresSqlConnection(db)) {
                throw new Error("PostgreSQL discovery snapshot requires PostgreSQL state");
              }
              // sqlite-allow-raw: This PostgreSQL transaction must outlive the asynchronous snapshot consumer.
              db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
              const snapshot =
                /* sqlite-allow-raw: PostgreSQL exports the retained transaction's MVCC snapshot. */ db
                  .prepare("SELECT pg_export_snapshot() AS snapshot")
                  .get()?.snapshot;
              const response = await channel.request(snapshot);
              response.consumed();
            } finally {
              try {
                if (db.isTransaction) {
                  // sqlite-allow-raw: Release the exporting PostgreSQL transaction after its consumer settles.
                  db.exec("ROLLBACK");
                }
              } finally {
                connection.close();
              }
            }
          }
          return { ok: true, type: "admit" };
        }
        const locationArgs = [
          input.databasePath,
          input.location,
          undefined,
          input.expectedIdentity,
          input.snapshotRoot,
          true,
        ] as const;
        if (command.type === "plugins.metadata.read") {
          const result = withOpenClawStateReadOnlyLocation(
            ({ db }) => {
              sourceAdmitted = true;
              return pluginMetadataReadOperations[command.type](command.input, db);
            },
            ...locationArgs,
          );
          return { ok: true, sourceAdmitted: true, ...result };
        }
        if (command.type === "gatewayOwnerLease.read") {
          if (!leaseReader) {
            throw new Error("Gateway owner lease reader is unavailable");
          }
          const lease = leaseReader.inspectGatewayOwnerLease(
            input,
            () => {
              sourceAdmitted = true;
            },
            command.schemaMaintenance,
          );
          return { ok: true, type: command.type, sourceAdmitted: true, lease };
        }
        if (stateReadRegistry.has(command)) {
          const result = withOpenClawStateReadOnlyLocation(
            ({ db }) => {
              sourceAdmitted = true;
              return stateReadRegistry.execute(command, db);
            },
            ...locationArgs,
          );
          return { ok: true, sourceAdmitted: true, ...result };
        }
        if (!handlers) {
          throw new Error("State read command handlers are unavailable");
        }
        if (command.type === "subagents.restore" || command.type === "meetingTranscripts.export") {
          return await control.runNativeSection(() =>
            handlers.readStateStream(input, command, channel, () => {
              sourceAdmitted = true;
            }),
          );
        }
        if (command.type === "agentDatabaseRegistry.read") {
          const result = readOpenClawStateReadOnlyLocation(
            ({ db }) => {
              sourceAdmitted = true;
              return handlers.readRegisteredAgentDatabaseRows(db, input.databasePath, false);
            },
            ...locationArgs,
          );
          return {
            ok: true,
            type: command.type,
            sourceAdmitted,
            result:
              result.status === "available"
                ? { status: "available", entries: result.value }
                : { status: "unavailable" },
          };
        }
        if (command.type === "subagents.sessionList") {
          const result = readOpenClawStateReadOnlyLocation(
            ({ db }) => {
              sourceAdmitted = true;
              return handlers.loadSubagentSessionListRunsFromSqlite(undefined, { db });
            },
            ...locationArgs,
          );
          if (result.status === "unavailable" && sourceAdmitted !== true) {
            throw result.error;
          }
          return result.status === "available"
            ? { ok: true, type: command.type, sourceAdmitted: true, runs: result.value }
            : {
                ok: true,
                type: command.type,
                sourceAdmitted: true,
                unavailable: {
                  message: String(result.error),
                  error: encodeOpenClawStateWorkerError(result.error, {
                    includeOrdinary: true,
                  }),
                },
              };
        }
        const metadataRead =
          command.type === "acpSessions.metadata"
            ? handlers.prepareAcpSessionMetadataRead(command)
            : undefined;
        const result = withOpenClawStateReadOnlyLocation(
          ({ db }): OpenClawStateReadResult => {
            sourceAdmitted = true;
            return handlers.readOpenClawStateDatabaseCommand(db, input, command, metadataRead);
          },
          ...locationArgs,
          metadataRead?.readContentVersionRow,
        );
        return { ok: true, sourceAdmitted: true, ...result };
      };
      const selection = input.context.databaseEngineSelection ?? getDatabaseEngineSelection();
      const execute = () =>
        withSqliteReaderOwner({ operation: input.command.type, ownerKind: "worker" }, () =>
          runWithSqliteWorkerStateContext(input.context, executeRead),
        );
      const run = () =>
        input.postgresSnapshot
          ? postgresStateReadSnapshot.run(
              { path: input.databasePath, snapshot: input.postgresSnapshot },
              execute,
            )
          : execute();
      const reply = await (selection ? withDatabaseEngineSelection(selection, run) : run());
      if (
        !getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources &&
        bunSqliteNativeCleanupPending
      ) {
        nativeCleanupFailure ??= { error: undefined };
      }
      return nativeCleanupFailure ? { ...reply, nativeCleanupFailure } : reply;
    } catch (value) {
      const error = toStringifiedError(value);
      return {
        ok: false,
        sourceAdmitted,
        message: error.message,
        error: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
        ...(nativeCleanupFailure ? { nativeCleanupFailure } : {}),
      };
    }
  },
  { closeResource: closeRetainedOpenClawStateReadConnections },
);
