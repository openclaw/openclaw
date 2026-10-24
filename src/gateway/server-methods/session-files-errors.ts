import {
  ErrorCodes,
  errorShape,
  type SessionFileEntry,
} from "../../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../workspace-file-limits.js";
import type { RespondFn } from "./types.js";

export function sessionFilesError(
  type: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, {
    details: {
      type,
      ...details,
    },
  });
}

export function respondSessionFileTooLarge(
  respond: RespondFn,
  file: SessionFileEntry,
  filePath: string,
) {
  respond(
    false,
    undefined,
    sessionFilesError("session_file_too_large", "session file is too large to preview", {
      maxPreviewBytes: WORKSPACE_PREVIEW_MAX_BYTES,
      path: file.path || filePath,
      size: file.size,
    }),
  );
}

export function respondSessionFileNotFound(respond: RespondFn, filePath: string, reason?: string) {
  respond(
    false,
    undefined,
    sessionFilesError("session_file_not_found", "session file not found", {
      path: filePath,
      ...(reason ? { reason } : {}),
    }),
  );
}

export function rejectDeviceFolderFiles(
  entry: Pick<InternalSessionEntry, "deviceFolder"> | undefined,
  respond: RespondFn,
): boolean {
  if (!entry?.deviceFolder) {
    return false;
  }
  respond(
    false,
    undefined,
    sessionFilesError(
      "device_folder_files_unavailable",
      "Files access is unavailable for existing folders on paired devices. Use the session's file tools on the selected device.",
    ),
  );
  return true;
}
