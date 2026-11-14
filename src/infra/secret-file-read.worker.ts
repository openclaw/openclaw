import type { FsSafeNativeMode } from "@openclaw/fs-safe/config";
import {
  FsSafeError,
  type FsSafeErrorCode,
  type FsSafeErrorDetails,
} from "@openclaw/fs-safe/errors";
import { readSecretFileSync, type SecretFileReadOptions } from "@openclaw/fs-safe/secret";
import { withWorkerFsSafeNativeMode } from "./worker-fs-safe.js";
import { encodeNativeWorkerFailure, type NativeWorkerFailure } from "./worker-native-error.js";
import { serveWorkerTasks } from "./worker-task-server.js";

export type SecretFileReadRequest = {
  filePath: string;
  label: string;
  options: SecretFileReadOptions;
  nativeMode: FsSafeNativeMode;
};
export type SecretFileReadReply =
  | { kind: "read"; value: string }
  | {
      kind: "failed";
      error: NativeWorkerFailure;
      code?: FsSafeErrorCode;
      details?: FsSafeErrorDetails;
    };

serveWorkerTasks<SecretFileReadReply, SecretFileReadRequest>((request, _channel, control) =>
  withWorkerFsSafeNativeMode(request.nativeMode, () =>
    control.runNativeSection(() => {
      try {
        return {
          kind: "read",
          value: readSecretFileSync(request.filePath, request.label, request.options),
        };
      } catch (error) {
        return {
          kind: "failed",
          error: encodeNativeWorkerFailure(error),
          ...(error instanceof FsSafeError ? { code: error.code, details: error.details } : {}),
        };
      }
    }),
  ),
);
