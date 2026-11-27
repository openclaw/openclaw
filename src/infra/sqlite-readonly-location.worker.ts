import path from "node:path";
import { deserialize } from "node:v8";
import { isRecord, isStringArray } from "@openclaw/normalization-core/record-coerce";
import { scheduleOpenClawCompileCacheFlush } from "../../node-compile-cache.mjs";
import type { AuthProfileReadDatabaseOpener } from "../agents/auth-profiles/sqlite-read-pool.js";
import { routeLogsToStderr } from "../logging/console.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { jsonFieldBatches } from "./json-field-transfer.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "./node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import { useConnectionScopedSqliteDatabaseAdmissionFacts } from "./sqlite-database-admission.js";
import { formatSqliteReadOnlyInspectionFailure } from "./sqlite-error-diagnostics.js";
import { readSqliteAuthSchema } from "./sqlite-readonly-auth-schema.js";
import { encodeSqliteAuthTransferFrame } from "./sqlite-readonly-auth-transfer.js";
import {
  releaseSnapshotTempDirectory,
  registerSnapshotTempDirectory,
  removeTempDirectoryAsync,
  cleanupSnapshotOperations,
} from "./sqlite-readonly-location-cleanup.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { sqliteReadOnlyOperations } from "./sqlite-readonly-operation-registry.js";
import {
  SQLITE_READONLY_WORKER_MAX_BUFFER,
  isSqliteSnapshotStagingMode,
  type SqliteReadOnlyWorkerResult,
} from "./sqlite-readonly-worker-protocol.js";
import type { SqliteStagingToken } from "./sqlite-staging-token.js";
import { assertExistingDatabaseIdentity } from "./sqlite-worker-identity.js";
import { createSqliteWorkerTransferOwner } from "./sqlite-worker-transfer.js";

function runSession(): void {
  const stagingTokens = new Map<string, SqliteStagingToken>();
  let busy = false;
  let closeRequested = false;
  let stopping = false;
  let finalExitCode = 0;
  let retiring = false;
  let activeWork = Promise.resolve();
  const transfers = createSqliteWorkerTransferOwner();
  let activeTransfer: { requestId: number; transferId: number; label: string } | undefined;
  const stop = (failed = false, orphaned = false) => {
    if (failed) {
      finalExitCode = 1;
    }
    if (stopping) {
      return;
    }
    stopping = true;
    // Pending imports and copies must settle before releasing their native tokens.
    const retire = async () => {
      if (orphaned) {
        for (const [directory, token] of stagingTokens) {
          registerSnapshotTempDirectory(directory, token);
          // A surviving copy holds a read token and finishes its own retirement.
          await removeTempDirectoryAsync(directory);
        }
      }
      await cleanupSnapshotOperations();
      const cleanup = [() => transfers.close(), ...stagingTokens.values()];
      for (const close of cleanup) {
        try {
          close();
        } catch (error) {
          finalExitCode = 1;
          process.stderr.write(
            `SQLite read-only worker cleanup failed: ${formatSqliteReadOnlyInspectionFailure(error)}\n`,
          );
        }
      }
      stagingTokens.clear();
      activeTransfer = undefined;
      process.stdin.destroy();
      if (process.connected) {
        process.disconnect?.();
      }
      process.exitCode = finalExitCode;
    };
    void activeWork.then(retire, retire);
  };
  const send = (id: number, result: unknown, failed = false, onSent?: () => void) => {
    if (stopping) {
      return;
    }
    if (!process.connected || !process.send) {
      stop(true);
      return;
    }
    // A terminal reply closes admission now, but IPC stays owned until its write drains.
    retiring ||= failed;
    try {
      process.send({ id, result }, (error) => {
        if (error || failed) {
          stop(true);
          return;
        }
        onSent?.();
        if (closeRequested && !busy) {
          stop();
        }
      });
    } catch {
      stop(true);
    }
  };
  const fail = (id: number, error: unknown) => {
    send(id, { ok: false, message: formatSqliteReadOnlyInspectionFailure(error) }, true);
  };
  process.once("disconnect", () => stop(busy, true));
  process.on("message", (message: unknown) => {
    if (stopping || retiring) {
      return;
    }
    if (message === "close") {
      if (busy) {
        closeRequested = true;
      } else {
        stop();
      }
      return;
    }
    if (
      isRecord(message) &&
      activeTransfer &&
      message.id === activeTransfer.requestId &&
      isRecord(message.transfer)
    ) {
      const { requestId, transferId, label } = activeTransfer;
      try {
        if (message.transfer.transferId !== transferId) {
          throw new Error(`${label} transfer identity changed`);
        }
        if (message.transfer.type === "next") {
          send(requestId, {
            type: "frame",
            frame: encodeSqliteAuthTransferFrame(transfers.next(transferId)),
          });
        } else if (message.transfer.type === "end") {
          transfers.end(transferId);
          activeTransfer = undefined;
          busy = false;
          send(requestId, { type: "complete" });
        } else {
          throw new Error(`Invalid ${label.toLowerCase()} transfer command`);
        }
      } catch (error) {
        fail(requestId, error);
      }
      return;
    }
    if (
      !busy &&
      isRecord(message) &&
      typeof message.id === "number" &&
      Number.isSafeInteger(message.id) &&
      Array.isArray(message.args) &&
      message.args.length === 2 &&
      (message.args[0] === "auth-profile-rows" || message.args[0] === "operation") &&
      typeof message.args[1] === "string"
    ) {
      const id = message.id;
      const pathname = message.args[1];
      const operation = message.args[0] === "operation";
      const read = operation ? message.operation : message.auth;
      busy = true;
      const execute = async () => {
        if (
          !isRecord(read) ||
          typeof read.expectedIdentity !== "string" ||
          !read.expectedIdentity.startsWith("file:") ||
          (read.expectedBirthtime !== undefined && typeof read.expectedBirthtime !== "string")
        ) {
          throw new Error(
            operation
              ? "SQLite read requires captured physical ownership"
              : "Auth profile read requires captured physical ownership",
          );
        }
        const { expectedIdentity, expectedBirthtime } = read;
        if (operation) {
          if (typeof read.command !== "string") {
            throw new Error("Invalid SQLite read-only operation encoding");
          }
          const command: unknown = deserialize(Buffer.from(read.command, "base64"));
          if (!isRecord(command) || typeof command.type !== "string" || !("input" in command)) {
            throw new Error("Invalid SQLite read-only operation");
          }
          const request = { type: command.type, input: command.input };
          await sqliteReadOnlyOperations.prepare(request.type);
          if (stopping) {
            return;
          }
          if (!sqliteReadOnlyOperations.has(request)) {
            throw new Error(`Unknown SQLite read-only operation: ${request.type}`);
          }
          assertExistingDatabaseIdentity(pathname, expectedIdentity, expectedBirthtime);
          const value = await sqliteReadOnlyOperations.execute(request, {
            path: pathname,
            env: process.env,
            assertCurrent: () => {
              if (stopping) {
                throw new Error("SQLite read-only worker is stopping");
              }
              assertExistingDatabaseIdentity(pathname, expectedIdentity, expectedBirthtime);
            },
          });
          if (stopping) {
            return;
          }
          assertExistingDatabaseIdentity(pathname, expectedIdentity, expectedBirthtime);
          const handle = transfers.start(
            [{ kind: "result", value: { operation: request.type, value } }].values(),
            { kinds: ["result"] },
          );
          activeTransfer = { requestId: id, transferId: handle.id, label: "SQLite operation" };
          send(id, { type: "start", handle });
          return;
        }
        // Domain code stays child-only; importing it from the host would reverse storage ownership.
        const { readAuthProfileRowsReadOnly } =
          await import("../agents/auth-profiles/sqlite-json.js");
        const openReadOnlyDatabase: AuthProfileReadDatabaseOpener =
          read.immutable === true
            ? (databasePath, options) =>
                openNodeSqliteDatabase(resolveImmutableSqliteFileUri(databasePath), {
                  ...options,
                  readOnly: true,
                })
            : read.artifactPreserving === true
              ? (await import("./sqlite-snapshot-source.js")).openSqliteReadOnlyDatabase
              : (databasePath, options) =>
                  openNodeSqliteDatabase(databasePath, { ...options, readOnly: true });
        if (stopping) {
          return;
        }
        assertExistingDatabaseIdentity(pathname, expectedIdentity, expectedBirthtime);
        const rows = readAuthProfileRowsReadOnly(
          pathname,
          openReadOnlyDatabase,
          readSqliteAuthSchema(read.schema),
          expectedIdentity,
          read.retainReader === true,
        );
        if (read.artifactPreserving === true) {
          rows.cacheable = false;
        }
        assertExistingDatabaseIdentity(pathname, expectedIdentity, expectedBirthtime);
        function* rowFields() {
          for (const batch of jsonFieldBatches(rows)) {
            yield { kind: "fields", value: batch };
          }
        }
        const handle = transfers.start(rowFields(), { kinds: ["fields"] });
        activeTransfer = { requestId: id, transferId: handle.id, label: "Auth profile" };
        send(id, { type: "start", handle });
      };
      activeWork = (
        isRecord(read) && read.artifactPreserving === true
          ? withArtifactPreservingStateReads(execute, { agentDatabases: true })
          : execute()
      )
        .catch((error: unknown) => fail(id, error))
        .finally(scheduleOpenClawCompileCacheFlush);
      return;
    }
    if (
      busy ||
      !message ||
      typeof message !== "object" ||
      Object.keys(message).length !== 2 ||
      !("id" in message) ||
      typeof message.id !== "number" ||
      !Number.isSafeInteger(message.id) ||
      !("args" in message) ||
      !isStringArray(message.args) ||
      (message.args[0] !== "sync" &&
        message.args[0] !== "private-fork" &&
        !isSqliteSnapshotStagingMode(message.args[0]))
    ) {
      stop(true);
      return;
    }
    busy = true;
    const id = message.id;
    const args = message.args;
    const staging = isSqliteSnapshotStagingMode(args[0]);
    let prepared: PreparedSqliteReadOnlyLocation | undefined;
    // Admission covers the import too. Disconnect must join the accepted work before releasing tokens.
    activeWork = import("./sqlite-readonly-location.inspection.js")
      .then(({ inspectSqliteReadOnlyLocation }) =>
        inspectSqliteReadOnlyLocation(args, stagingTokens, (snapshot) => {
          prepared = snapshot;
        }),
      )
      .then((inspected) => {
        const result: SqliteReadOnlyWorkerResult =
          Buffer.byteLength(JSON.stringify(inspected)) > SQLITE_READONLY_WORKER_MAX_BUFFER
            ? { ok: false, message: "exceeded its output buffer" }
            : inspected;
        // Failed private recovery must retire this process, never admit another read.
        send(id, result, !result.ok && !staging, () => {
          if (prepared) {
            releaseSnapshotTempDirectory(prepared.cleanupRoot ?? path.dirname(prepared.location));
          }
          busy = false;
        });
      })
      .catch((error: unknown) => fail(id, error))
      .finally(scheduleOpenClawCompileCacheFlush);
  });
}

if (process.argv[2] === SQLITE_READONLY_CHILD_ARG) {
  // One-shot stdout is the JSON result, and sessions may inherit a JSON caller's stdout.
  routeLogsToStderr();
  useConnectionScopedSqliteDatabaseAdmissionFacts();
  if (process.argv[3] === "session" && process.send) {
    runSession();
  } else {
    process.stdout.on("error", () => {
      // The write callback owns delivery failure, including a vanished parent.
    });
    const args = process.argv.slice(3);
    void import("./sqlite-readonly-location.inspection.js")
      .then(({ runSqliteReadOnlyInspection }) => runSqliteReadOnlyInspection(args))
      .catch((error: unknown) => {
        process.exitCode = 1;
        process.stderr.write(`${formatSqliteReadOnlyInspectionFailure(error)}\n`);
      });
  }
}
