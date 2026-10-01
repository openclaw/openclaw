import fs from "node:fs/promises";
import path from "node:path";
import { MessagePort, workerData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "./sqlite-lifecycle-errors.js";
import { SqliteSnapshotCleanupError } from "./sqlite-readonly-location-cleanup.js";
import { createSqliteReadOnlyNativeResourceClient } from "./sqlite-readonly-native-resource.client.js";
import { SQLITE_NATIVE_RESOURCE_PORT } from "./sqlite-readonly-native-resource.types.js";
import { createSqliteSnapshotStagingRuntime } from "./sqlite-snapshot-staging-runtime.js";
import type {
  SqliteSnapshotStagingCommand,
  SqliteSnapshotStagingLaunch,
  SqliteSnapshotStagingReply,
} from "./sqlite-snapshot-staging.types.js";
import { readDatabaseFileIdentity } from "./sqlite-worker-identity.js";
import { serveOwnedWorkerTasks } from "./worker-task-server.js";

const resourcePort: unknown = isRecord(workerData)
  ? workerData[SQLITE_NATIVE_RESOURCE_PORT]
  : undefined;
if (!(resourcePort instanceof MessagePort)) {
  throw new Error("SQLite snapshot staging requires its native lifetime owner");
}
const native = createSqliteReadOnlyNativeResourceClient(resourcePort);
const runtime = createSqliteSnapshotStagingRuntime((launch) => native.createSession(launch));
const directories = new Map<string, { retire: () => Promise<void>; removed: boolean }>();

function readPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("SQLite snapshot staging requires a nonempty filesystem path");
  }
  return value;
}

function readLaunch(value: unknown): SqliteSnapshotStagingLaunch {
  if (
    !isRecord(value) ||
    !isRecord(value.env) ||
    !isRecord(value.transport) ||
    value.transport.kind !== "native"
  ) {
    throw new Error("SQLite snapshot staging requires its captured native launch");
  }
  const entries: Array<[string, string | undefined]> = [];
  for (const [key, item] of Object.entries(value.env)) {
    if (
      key.length === 0 ||
      key.includes("=") ||
      key.includes("\0") ||
      (item !== undefined && (typeof item !== "string" || item.includes("\0")))
    ) {
      throw new Error("SQLite snapshot staging received an invalid launch environment");
    }
    entries.push([key, item]);
  }
  return {
    env: Object.fromEntries(entries),
    cwd: readPath(value.cwd),
    transport: { kind: "native" },
  };
}

function readCommand(value: unknown): SqliteSnapshotStagingCommand {
  if (
    !isRecord(value) ||
    typeof value.allowLegacyWorker !== "boolean" ||
    typeof value.preparationId !== "number" ||
    !Number.isSafeInteger(value.preparationId) ||
    value.preparationId < 1
  ) {
    throw new Error("SQLite snapshot staging requires an allocation command");
  }
  const launch = readLaunch(value.launch);
  const allocation = {
    preparationId: value.preparationId,
    root: path.resolve(launch.cwd, readPath(value.root)),
    allowLegacyWorker: value.allowLegacyWorker,
    launch,
  };
  if (value.type === "allocate" && value.abortPort === undefined) {
    return { type: "allocate", ...allocation };
  }
  if (
    value.type !== "prepare" ||
    typeof value.preserveSourceArtifacts !== "boolean" ||
    typeof value.deadlineOwnedByCaller !== "boolean" ||
    (value.abortPort !== undefined && !(value.abortPort instanceof MessagePort))
  ) {
    throw new Error("SQLite snapshot staging requires a valid preparation command");
  }
  const expectedSourceIdentity =
    value.expectedSourceIdentity === undefined
      ? undefined
      : readDatabaseFileIdentity(value.expectedSourceIdentity);
  if (expectedSourceIdentity && !value.preserveSourceArtifacts) {
    throw new Error("SQLite source identity requires artifact-preserving preparation");
  }
  return {
    type: "prepare",
    ...allocation,
    pathname: path.resolve(launch.cwd, readPath(value.pathname)),
    preserveSourceArtifacts: value.preserveSourceArtifacts,
    expectedSourceIdentity,
    deadlineOwnedByCaller: value.deadlineOwnedByCaller,
    abortPort: value.abortPort,
  };
}

async function closeDirectory(directory: string): Promise<void> {
  const owned = directories.get(directory);
  if (!owned) {
    return;
  }
  if (!owned.removed) {
    await owned.retire();
    await fs.rm(directory, { force: true, recursive: true, maxRetries: 3, retryDelay: 20 });
    owned.removed = true;
  }
  await native.removed(directory);
  directories.delete(directory);
}

async function closeResource(directory?: string): Promise<void> {
  if (directory !== undefined) {
    await closeDirectory(directory);
    return;
  }
  const errors: unknown[] = [];
  for (const pending of directories.keys()) {
    try {
      await closeDirectory(pending);
    } catch (error) {
      errors.push(error);
    }
  }
  if (directories.size === 0) {
    try {
      // Failed allocation may retain a child even without publishing a directory.
      await runtime.close();
    } catch (error) {
      errors.push(error);
    }
  }
  throwSqliteLifecycleErrors(errors, "SQLite snapshot staging cleanup failed");
}

serveOwnedWorkerTasks<SqliteSnapshotStagingReply>(
  async (value): Promise<SqliteSnapshotStagingReply> => {
    const port =
      isRecord(value) && value.abortPort instanceof MessagePort ? value.abortPort : undefined;
    let abort: ((message: unknown) => void) | undefined;
    try {
      const command = readCommand(value);
      const controller = new AbortController();
      if (command.type === "prepare" && port) {
        abort = (message) => {
          if (isRecord(message) && message.type === "abort") {
            controller.abort(new Error("SQLite snapshot preparation stopped"));
          }
        };
        port.on("message", abort);
      }
      let directory: string | undefined;
      try {
        const owned = await runtime.allocate(
          command.root,
          command.allowLegacyWorker,
          command.launch,
          command.preparationId,
        );
        directory = owned.directory;
        directories.set(directory, { retire: owned.retire, removed: false });
        if (command.type === "allocate") {
          return { type: "allocated", directory };
        }
        controller.signal.throwIfAborted();
        const location = await native.runOnce(
          command.pathname,
          {
            mode: command.preserveSourceArtifacts ? "sync" : "async",
            stagingRoot: directory,
            expectedSourceIdentity: command.expectedSourceIdentity,
            signal: controller.signal,
          },
          { ...command.launch, deadlineOwnedByCaller: command.deadlineOwnedByCaller },
        );
        controller.signal.throwIfAborted();
        if (typeof location !== "string") {
          throw new Error("SQLite snapshot preparation returned an invalid location");
        }
        return { type: "prepared", directory, location };
      } catch (error) {
        let failure = error;
        let cleanupFailure = error instanceof SqliteSnapshotCleanupError;
        if (directory !== undefined) {
          try {
            await closeDirectory(directory);
          } catch (cleanupError) {
            cleanupFailure = true;
            failure = createSqliteLifecycleAggregateError(
              [error, cleanupError],
              "SQLite snapshot preparation and cleanup failed",
              error,
            );
          }
        }
        const encoded =
          encodeOpenClawStateWorkerError(failure, { includeOrdinary: true }) ??
          encodeOpenClawStateWorkerError(new Error("SQLite snapshot staging failed"), {
            includeOrdinary: true,
          });
        if (!encoded) {
          throw failure;
        }
        return {
          type: "failed",
          error: encoded,
          ...(cleanupFailure ? { cleanupFailure: true } : {}),
          ...(directory !== undefined && directories.has(directory) ? { directory } : {}),
        };
      }
    } finally {
      if (abort) {
        port?.off("message", abort);
      }
      port?.close();
    }
  },
  {
    closeResource,
    encodeResourceError: (error) =>
      encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
  },
);
