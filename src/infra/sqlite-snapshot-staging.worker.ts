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
  SqliteSnapshotStagingReply,
} from "./sqlite-snapshot-staging.types.js";
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
    // SAFETY: The typed staging owner is the sole sender on this private worker transport.
    const command = value as SqliteSnapshotStagingCommand;
    const port = command.type === "prepare" ? command.abortPort : undefined;
    let abort: (() => void) | undefined;
    try {
      const controller = new AbortController();
      if (port) {
        abort = () => {
          controller.abort(new Error("SQLite snapshot preparation stopped"));
        };
        port.on("message", abort);
      }
      let directory: string | undefined;
      try {
        const owned = await runtime.allocate(
          path.resolve(command.launch.cwd, command.root),
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
          path.resolve(command.launch.cwd, command.pathname),
          {
            mode: command.preserveSourceArtifacts ? "sync" : "async",
            stagingRoot: directory,
            expectedSourceIdentity: command.expectedSourceIdentity,
            signal: controller.signal,
          },
          { ...command.launch, deadlineOwnedByCaller: command.deadlineOwnedByCaller },
        );
        controller.signal.throwIfAborted();
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
