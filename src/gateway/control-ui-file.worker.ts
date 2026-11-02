import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks } from "../infra/worker-task-server.js";
import { readControlUiFile, type ControlUiFileSnapshot } from "./control-ui-file.js";

serveWorkerTasks<ControlUiFileSnapshot | null>(
  (input) => {
    if (
      !isRecord(input) ||
      typeof input.rootPath !== "string" ||
      (input.rootRealPath !== undefined && typeof input.rootRealPath !== "string") ||
      typeof input.filePath !== "string" ||
      typeof input.rejectHardlinks !== "boolean" ||
      typeof input.readBody !== "boolean"
    ) {
      throw new Error("Invalid Control UI file read request");
    }
    return readControlUiFile({
      rootPath: input.rootPath,
      rootRealPath: input.rootRealPath,
      filePath: input.filePath,
      rejectHardlinks: input.rejectHardlinks,
      readBody: input.readBody,
    });
  },
  {
    transferList: (snapshot) =>
      snapshot?.body?.buffer instanceof ArrayBuffer ? [snapshot.body.buffer] : [],
  },
);
