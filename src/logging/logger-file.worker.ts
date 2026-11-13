import { serveWorkerTasks } from "../infra/worker-task-server.js";
import {
  executeFileLogIO,
  type FileLogIORequest,
  type FileLogIOResults,
} from "./logger-file-io.js";

serveWorkerTasks<FileLogIOResults[keyof FileLogIOResults], FileLogIORequest>(
  (request, _channel, control) => control.runNativeSection(() => executeFileLogIO(request)),
);
