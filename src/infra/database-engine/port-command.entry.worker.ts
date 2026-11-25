import { serveWorkerTasks } from "../worker-task-server.js";
import {
  executeDatabasePortTask,
  type DatabasePortReply,
  type DatabasePortTask,
} from "./port-command.worker.js";
import { databasePortProviders } from "./port-provider.js";
import { DatabasePortDataError } from "./port.worker.js";

serveWorkerTasks<DatabasePortReply, DatabasePortTask>((task, _channel, control) =>
  control.runNativeSection(async () => {
    try {
      return await executeDatabasePortTask(task, control.throwIfCancelled);
    } catch (error) {
      const fact =
        error instanceof DatabasePortDataError
          ? error.message
          : "observed database validation or I/O failure; required readable, valid data and namespace privileges";
      throw new Error(
        `${task.operation}: ${"sourcePath" in task ? task.sourcePath : databasePortProviders.map((provider) => provider.id).join(", ")}: ${fact}. Stop the Gateway, correct the source or connection, then retry or use the retained recovery manifest.`,
        { cause: error },
      );
    }
  }),
);
