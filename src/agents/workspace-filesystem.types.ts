import type { FileIdentityStat } from "@openclaw/fs-safe/advanced";
import type { FsSafeNativeMode } from "@openclaw/fs-safe/config";
import type { FsSafeErrorCode } from "../infra/fs-safe.js";
import type { NativeWorkerFailure } from "../infra/worker-native-error.js";

export type WorkspaceFileSourceIdentity = readonly [
  canonicalPath: string,
  stat: FileIdentityStat | undefined,
  workspaceRelativePath?: string,
];
export type WorkspaceGuardedReadResult =
  | { ok: true; content: string; sourceIdentity: WorkspaceFileSourceIdentity }
  | { ok: false; reason: "path" | "validation" | "io"; error?: unknown };

export type WorkspaceFilesystemReadCommand = {
  type: "workspace-read";
  nativeMode: FsSafeNativeMode;
  input: { filePath: string; workspaceDir: string; rejectAliases?: boolean; useCache: false };
};
export type WorkspaceFilesystemReadReply = {
  type: "workspace-read";
  result:
    | Extract<WorkspaceGuardedReadResult, { ok: true }>
    | {
        ok: false;
        reason: "path" | "validation" | "io";
        error?: NativeWorkerFailure;
        fsCode?: FsSafeErrorCode;
        details?: Readonly<Record<string, unknown>>;
      };
};
