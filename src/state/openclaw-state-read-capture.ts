import {
  readDebugProxyCaptureSessionEvents,
  readDebugProxyCaptureBlob,
} from "../proxy-capture/store-readonly.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadReply,
} from "./openclaw-state-read.types.js";

export function readCaptureCommand(
  db: Parameters<typeof readDebugProxyCaptureSessionEvents>[0],
  command: Extract<
    OpenClawStateReadCommand,
    { type: "capture.readOnlyEvents" | "capture.readOnlyBlob" }
  >,
): OpenClawStateReadReply {
  if (command.type === "capture.readOnlyEvents") {
    return {
      ok: true,
      type: command.type,
      sourceAdmitted: true,
      events: readDebugProxyCaptureSessionEvents(db, command.sessionId, command.limit),
    };
  }
  return {
    ok: true,
    type: command.type,
    sourceAdmitted: true,
    blob: readDebugProxyCaptureBlob(db, command.blobId),
  };
}
