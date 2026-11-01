import { readBackupEngine } from "../infra/database-engine/physical-store.js";
import {
  withDatabasePortConnection,
  withDatabasePortPostgres,
} from "../infra/database-engine/port-provider.js";
import { serveWorkerTasks } from "../infra/worker-task-server.js";
import {
  discardPostgresNamespace,
  fingerprintPostgresDatabase,
} from "./database-backup-core.worker.js";
import {
  capturePostgresBackupInWorker,
  preparePostgresRestoreInWorker,
  type BackupTask,
  type BackupReply,
} from "./database-backup.operations.js";

serveWorkerTasks<BackupReply, BackupTask>((task, _channel, control) => {
  if (task.operation === "discard") {
    return control.runNativeSection(() =>
      withDatabasePortConnection(task.params.config, async (client) => {
        for (const namespace of task.params.namespaces) {
          control.throwIfCancelled();
          await discardPostgresNamespace(client, namespace);
        }
      }),
    );
  }
  if (task.operation === "fingerprint" || task.operation === "family") {
    const anchor = readBackupEngine(task.params.sourcePath);
    if (anchor.engine !== "postgres") {
      throw new Error("PostgreSQL anchor disappeared.");
    }
    if (task.operation === "fingerprint") {
      return withDatabasePortConnection(task.params.config, (client) =>
        fingerprintPostgresDatabase({ client, anchor }),
      );
    }
    return withDatabasePortPostgres(
      task.params.config,
      anchor,
      (_client, descriptor) => Promise.resolve(descriptor.id),
      task.params.pluginOwners,
    );
  }
  return control.runNativeSection<BackupReply>(() =>
    task.operation === "capture"
      ? capturePostgresBackupInWorker({ ...task.params, assertCurrent: control.throwIfCancelled })
      : preparePostgresRestoreInWorker({
          ...task.params,
          assertCurrent: control.throwIfCancelled,
        }),
  );
});
