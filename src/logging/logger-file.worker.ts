import { serveWorkerTasks } from "../infra/worker-task-server.js";
import type { LogTailRequest } from "./log-tail-worker.js";
import type { LogTailPayload } from "./log-tail.js";
import {
  executeFileLogIO,
  type FileLogIORequest,
  type FileLogIOResults,
} from "./logger-file-io.js";

serveWorkerTasks<
  FileLogIOResults[keyof FileLogIOResults] | LogTailPayload,
  FileLogIORequest | LogTailRequest
>((request, _channel, control) =>
  control.runNativeSection(async () => {
    if (request.type === "tail") {
      const [
        { readLogTail },
        { resolveLogTailRedactOptions },
        { installSecretRedactionRegistrySnapshot },
      ] = await Promise.all([
        import("./log-tail.js"),
        import("./redact.js"),
        import("./secret-redaction-registry.js"),
      ]);
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
