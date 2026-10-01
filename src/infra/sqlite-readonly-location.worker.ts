import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isPrivateDirectoryCreationRefused } from "./private-directory-creation.js";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import {
  formatSqliteErrorCodeSuffix,
  formatSqliteReadOnlyInspectionFailure,
  isSqliteLockError,
  sqliteExtendedResultCode,
} from "./sqlite-error-diagnostics.js";
import { encodeSqliteAuthTransferFrame } from "./sqlite-readonly-auth-transfer.js";
import {
  releaseSnapshotTempDirectory,
  retireSqliteSnapshotPayload,
} from "./sqlite-readonly-location-cleanup.js";
import {
  createOnlineReadOnlyBackup,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
  SqliteSourceChangedError,
} from "./sqlite-readonly-location.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import {
  SQLITE_READONLY_WORKER_MAX_BUFFER,
  SQLITE_INSPECTION_CONTENTION_PREFIX,
  SQLITE_SNAPSHOT_ALLOCATION_REFUSED_PREFIX,
  isSqliteSnapshotStagingMode,
  isSqliteStagingTokenWorkerMode,
  type SqliteReadOnlyWorkerResult,
} from "./sqlite-readonly-worker-protocol.js";
import { beginSqliteSnapshotRetirement } from "./sqlite-snapshot-retirement.js";
import {
  createSqliteSnapshotStagingTokenSync,
  reclaimAbandonedSqliteSnapshots,
  reconcileSqliteSnapshotRetirement,
} from "./sqlite-snapshot-staging.js";
import {
  acquireSqliteStagingToken,
  assertSqliteStagingTokenIdentity,
  readSqliteStagingTokenIdentity,
  type SqliteStagingToken,
  type SqliteStagingTokenIdentity,
  type IdentifiedSqliteStagingToken,
} from "./sqlite-staging-token.js";
import {
  assertExistingDatabaseIdentity,
  readDatabaseFileIdentity,
} from "./sqlite-worker-identity.js";
import { createSqliteWorkerTransferOwner } from "./sqlite-worker-transfer.js";

type StagingToken =
  | { kind: "snapshot"; token: SqliteStagingToken }
  | {
      kind: "token";
      token: IdentifiedSqliteStagingToken;
      identity: SqliteStagingTokenIdentity;
      preparationId: number;
    };
const stagingTokens = new Map<string, StagingToken>();

// Artifact-preserving sync requests must not open SQLite on the source. Live
// async backups pin committed pages with a read transaction and may update SHM.
async function inspect(args: string[]): Promise<SqliteReadOnlyWorkerResult> {
  const mode = args[0];
  const pathname = args[1];
  const stagingRoot = args[2] || undefined;
  if (
    (mode !== "sync" &&
      mode !== "async" &&
      mode !== "consolidated" &&
      mode !== "reclaim" &&
      !isSqliteSnapshotStagingMode(mode)) ||
    !pathname
  ) {
    return {
      ok: false,
      message: "SQLite read-only worker requires a mode and a database path",
    };
  }
  try {
    if (isSqliteStagingTokenWorkerMode(mode)) {
      const encodedIdentity = args[2];
      if (args.length !== 3 || encodedIdentity === undefined) {
        throw new Error("SQLite staging token requires captured identity");
      }
      const input: unknown = JSON.parse(encodedIdentity);
      if (
        !isRecord(input) ||
        typeof input.preparationId !== "number" ||
        !Number.isSafeInteger(input.preparationId) ||
        input.preparationId < 1
      ) {
        throw new Error("SQLite staging token requires a preparation identity");
      }
      const identity = readSqliteStagingTokenIdentity(input.identity);
      const preparationId = input.preparationId;
      let owned = stagingTokens.get(pathname);
      if (
        owned &&
        (owned.kind !== "token" ||
          owned.preparationId !== preparationId ||
          JSON.stringify(owned.identity) !== JSON.stringify(identity))
      ) {
        throw new Error("SQLite staging token belongs to another preparation");
      }
      if (mode === "token-close") {
        owned?.token();
        stagingTokens.delete(pathname);
        return { ok: true, tokenIdentity: identity };
      }
      assertSqliteStagingTokenIdentity(pathname, identity);
      if (
        mode === "token-create" ||
        mode === "token-reclaim" ||
        (mode === "token-reconcile" && !owned)
      ) {
        if (owned) {
          throw new Error("SQLite staging token is already acquired");
        }
        const retain = (token: IdentifiedSqliteStagingToken) => {
          stagingTokens.set(pathname, { kind: "token", token, identity, preparationId });
        };
        const token = acquireSqliteStagingToken(
          pathname,
          mode === "token-create" ? "create" : "reclaim",
          {
            expectedIdentity: identity,
            retainCleanup: retain,
          },
        );
        retain(token);
        owned = stagingTokens.get(pathname);
      }
      if (!owned || owned.kind !== "token") {
        throw new Error("SQLite staging token is not owned by this worker");
      }
      if (mode === "token-retire" || mode === "token-reconcile") {
        owned.token(true);
        stagingTokens.delete(pathname);
      }
      return { ok: true, tokenIdentity: owned.token.getIdentity() };
    }
    if (args.length > 4 || (args[3] !== undefined && mode !== "sync")) {
      throw new Error(
        "SQLite source identity is supported only for artifact-preserving sync copies",
      );
    }
    const expectedSourceIdentity =
      args[3] === undefined ? undefined : readDatabaseFileIdentity(JSON.parse(args[3]));
    if (mode === "staging-reconcile") {
      reconcileSqliteSnapshotRetirement(pathname);
      return { ok: true, location: pathname };
    }
    if (mode === "staging-create" || mode === "staging-create-legacy") {
      const owned = createSqliteSnapshotStagingTokenSync(
        pathname,
        mode === "staging-create-legacy",
      );
      stagingTokens.set(owned.directory, { kind: "snapshot", token: owned.release });
      return { ok: true, location: owned.directory };
    }
    if (mode === "staging-retire") {
      const owned = stagingTokens.get(pathname);
      if (!owned || owned.kind !== "snapshot") {
        throw new Error("SQLite snapshot token is not owned by this worker");
      }
      const retirement = beginSqliteSnapshotRetirement(pathname, { token: owned.token });
      try {
        retireSqliteSnapshotPayload(retirement);
        stagingTokens.delete(pathname);
      } finally {
        retirement.release();
      }
      return { ok: true, location: pathname };
    }
    if (mode === "reclaim") {
      const warnings: string[] = [];
      const directories = reclaimAbandonedSqliteSnapshots(pathname, (message, error) => {
        warnings.push(`${message}${formatSqliteErrorCodeSuffix(error)}`);
      });
      let stopped = false;
      const stop = () => {
        stopped = true;
      };
      // EOF also handles a vanished parent. Never interrupt a directory's delete.
      process.stdin.once("end", stop);
      process.stdin.once("error", stop);
      process.stdin.resume();
      try {
        while (true) {
          await setImmediate();
          if (stopped) {
            warnings.push("Stopped SQLite snapshot reclamation at a directory boundary.");
            break;
          }
          if (directories.next().done) {
            break;
          }
        }
      } finally {
        directories.return(undefined);
        process.stdin.off("end", stop);
        process.stdin.off("error", stop);
        process.stdin.destroy();
      }
      return { ok: true, warnings };
    }
    let prepared: PreparedSqliteReadOnlyLocation;
    if (mode === "consolidated") {
      if (!stagingRoot || path.dirname(path.resolve(pathname)) !== path.resolve(stagingRoot)) {
        throw new Error(
          "SQLite consolidation requires its caller-owned private snapshot directory",
        );
      }
      // The backup owner admits a child staging token before reading the private
      // WAL family. Parent loss cannot let reclamation race its native backup.
      prepared = await createOnlineReadOnlyBackup(pathname, stagingRoot);
    } else {
      prepared =
        mode === "sync"
          ? prepareSqliteReadOnlyLocationSyncInProcess(
              pathname,
              stagingRoot,
              expectedSourceIdentity,
            )
          : await prepareSqliteReadOnlyLocationInProcess(pathname, stagingRoot);
    }
    releaseSnapshotTempDirectory(prepared.cleanupRoot ?? path.dirname(prepared.location));
    return { ok: true, location: prepared.location };
  } catch (error) {
    const contention = error instanceof SqliteSourceChangedError || isSqliteLockError(error);
    const allocationRefused =
      (mode === "staging-create" || mode === "staging-create-legacy") &&
      isPrivateDirectoryCreationRefused(error);
    const prefix =
      (contention ? SQLITE_INSPECTION_CONTENTION_PREFIX : "") +
      (allocationRefused ? SQLITE_SNAPSHOT_ALLOCATION_REFUSED_PREFIX : "");
    const errcode = isSqliteStagingTokenWorkerMode(mode)
      ? sqliteExtendedResultCode(error)
      : undefined;
    return {
      ok: false,
      ...(errcode !== undefined && errcode >= 0 && errcode <= 0x7fff_ffff ? { errcode } : {}),
      ...(isSqliteStagingTokenWorkerMode(mode) &&
      error instanceof Error &&
      "code" in error &&
      (typeof error.code === "string" || typeof error.code === "number")
        ? { code: error.code }
        : {}),
      message: `${prefix}${formatSqliteReadOnlyInspectionFailure(error)}`,
    };
  }
}

function runSession(): void {
  let busy = false;
  let closeRequested = false;
  const transfers = createSqliteWorkerTransferOwner();
  let activeTransfer: { requestId: number; transferId: number } | undefined;
  const send = (id: number, result: unknown, failed = false) => {
    process.send?.({ id, result }, (error) => {
      if (error || failed) {
        transfers.close();
        process.exit(1);
      }
    });
  };
  const fail = (id: number, error: unknown) => {
    transfers.close();
    send(id, { ok: false, message: formatSqliteReadOnlyInspectionFailure(error) }, true);
  };
  process.once("disconnect", () => {
    if (busy) {
      transfers.close();
      process.exit(1);
    }
  });
  process.on("message", (message: unknown) => {
    if (message === "close") {
      if (busy) {
        closeRequested = true;
      } else {
        transfers.close();
        process.disconnect?.();
      }
      return;
    }
    if (
      isRecord(message) &&
      activeTransfer &&
      message.id === activeTransfer.requestId &&
      isRecord(message.transfer)
    ) {
      const { requestId, transferId } = activeTransfer;
      try {
        if (message.transfer.transferId !== transferId) {
          throw new Error("Auth profile transfer identity changed");
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
          throw new Error("Invalid auth profile transfer command");
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
      message.args[0] === "auth-profile-rows" &&
      typeof message.args[1] === "string"
    ) {
      const id = message.id;
      const pathname = message.args[1];
      const auth = message.auth;
      busy = true;
      void (async () => {
        if (
          !isRecord(auth) ||
          typeof auth.expectedIdentity !== "string" ||
          !auth.expectedIdentity.startsWith("file:")
        ) {
          throw new Error("Auth profile read requires captured physical ownership");
        }
        const { expectedIdentity } = auth;
        // Domain code stays child-only; importing it from the host would reverse storage ownership.
        const { readAuthProfileRowsReadOnly } =
          await import("../agents/auth-profiles/sqlite-json.js");
        assertExistingDatabaseIdentity(pathname, expectedIdentity);
        const rows = readAuthProfileRowsReadOnly(pathname);
        assertExistingDatabaseIdentity(pathname, expectedIdentity);
        const handle = transfers.start(
          [
            { kind: "store", value: rows.store },
            { kind: "state", value: rows.state },
          ].values(),
          { kinds: ["store", "state"] },
        );
        activeTransfer = { requestId: id, transferId: handle.id };
        send(id, { type: "start", handle: { ...handle, cacheable: rows.cacheable } });
      })().catch((error: unknown) => fail(id, error));
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
      !Array.isArray(message.args) ||
      (message.args[0] !== "sync" && !isSqliteSnapshotStagingMode(message.args[0])) ||
      !message.args.every((arg): arg is string => typeof arg === "string")
    ) {
      process.exit(1);
    }
    busy = true;
    const id = message.id;
    const staging = isSqliteSnapshotStagingMode(message.args[0]);
    void inspect(message.args).then((inspected) => {
      const result: SqliteReadOnlyWorkerResult =
        Buffer.byteLength(JSON.stringify(inspected)) > SQLITE_READONLY_WORKER_MAX_BUFFER
          ? { ok: false, message: "exceeded its output buffer" }
          : inspected;
      process.send?.({ id, result }, (error) => {
        if (error || (!result.ok && !staging)) {
          // Failed private recovery can retain a native handle until process exit.
          process.exit(1);
          return;
        }
        busy = false;
        if (closeRequested) {
          process.disconnect?.();
        }
      });
    });
  });
}

if (process.argv[2] === SQLITE_READONLY_CHILD_ARG) {
  if (process.argv[3] === "session" && process.send) {
    runSession();
  } else {
    void inspect(process.argv.slice(3)).then((result) => {
      if (!result.ok) {
        process.exitCode = 1;
      }
      process.stdout.write(JSON.stringify(result));
    });
  }
}
