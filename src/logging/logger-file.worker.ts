import { serveWorkerTasks } from "../infra/worker-task-server.js";
import type { LogTailRequest } from "./log-tail-worker.js";
import { readLogTail, type LogTailPayload } from "./log-tail.js";
import {
  executeFileLogIO,
  type FileLogIORequest,
  type FileLogIOResults,
} from "./logger-file-io.js";
import { resolveLogTailRedactOptions } from "./redact.js";
import { installSecretRedactionRegistrySnapshot } from "./secret-redaction-registry.js";

serveWorkerTasks<
  FileLogIOResults[keyof FileLogIOResults] | LogTailPayload,
  FileLogIORequest | LogTailRequest
>((request, _channel, control) =>
  control.runNativeSection(async () => {
    if (request.type === "tail") {
      installSecretRedactionRegistrySnapshot(request.secrets);
      return readLogTail(
        request.target,
        request.params,
        resolveLogTailRedactOptions({ redactPatterns: request.redactPatterns }),
      );
    }
    return executeFileLogIO(request);
  }),
);
