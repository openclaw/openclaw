import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
import type { DatabaseFileIdentity } from "./sqlite-worker-identity.js";

export const SQLITE_NATIVE_RESOURCE_PORT = "sqliteSnapshotNativeResource";

export type SqliteNativeOwnerRequest = { id: number; directory: string } & (
  | { type: "allocated"; preparationId: number }
  | { type: "retire" | "removed" }
);
export type SqliteNativeOwnerReply =
  | { id: number; ok: true }
  | { id: number; ok: false; error: OpenClawStateWorkerErrorPayload };

export type SqliteNativeSessionLaunch = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  transport: { kind: "native" };
  retainLifetime?: boolean;
  retainOnOperationError?: boolean;
};
export type SqliteNativeCopyLaunch = Pick<SqliteNativeSessionLaunch, "env" | "cwd"> & {
  deadlineOwnedByCaller: boolean;
};
export type SqliteNativeStagingOptions =
  | { mode: "staging-create" | "staging-create-legacy"; preparationId: number }
  | { mode: "staging-retire" | "staging-reconcile" };
export type SqliteNativeStagingSession = {
  isRetired(): boolean;
  compatible(launch: SqliteNativeSessionLaunch): boolean;
  run(pathname: string, options: SqliteNativeStagingOptions): Promise<string>;
  close(): Promise<void>;
};
export type SqliteNativeCommand =
  | { type: "directory.removed"; directory: string }
  | { type: "session.create"; session: number; launch: SqliteNativeSessionLaunch }
  | ({ type: "session.run"; session: number; pathname: string } & SqliteNativeStagingOptions)
  | { type: "session.close"; session: number }
  | {
      type: "copy.run";
      pathname: string;
      mode: "sync" | "async";
      stagingRoot?: string;
      expectedSourceIdentity?: DatabaseFileIdentity;
      launch: SqliteNativeCopyLaunch;
    };
export type SqliteNativeRequest =
  | (SqliteNativeCommand & { id: number })
  | { type: "copy.cancel"; id: number };
export type SqliteNativeReply =
  | ({ type: "result"; id: number; retired?: boolean } & (
      | { ok: true; value?: string }
      | { ok: false; error: OpenClawStateWorkerErrorPayload }
    ))
  | { type: "session.closed"; session: number };
