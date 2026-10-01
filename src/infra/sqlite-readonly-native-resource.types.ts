import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
import type { SqliteStagingTokenIdentity } from "./sqlite-staging-token.js";
import type { DatabaseFileIdentity } from "./sqlite-worker-identity.js";

export const SQLITE_NATIVE_RESOURCE_PORT = "sqliteSnapshotNativeResource";

export type SqliteNativeOwnerRequest = { id: number; directory: string } & (
  | { type: "allocated"; preparationId: number }
  | { type: "retire" | "removed" }
  | {
      type: "token-reserved";
      preparationId: number;
      identity: SqliteStagingTokenIdentity;
      mode: "create" | "reclaim";
    }
  | { type: "token-admitted" | "token-unavailable" | "token-disposition"; preparationId: number }
  | {
      type: "token-settled";
      preparationId: number;
      disposition: "retired" | "closed" | "not-started";
    }
);
export type SqliteNativeOwnerReply =
  | { id: number; ok: true; disposition?: "retire" | "close" }
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
export type SqliteNativeTokenReservation = {
  directory: string;
  identity: SqliteStagingTokenIdentity;
  preparationId: number;
  mode: "create" | "reclaim";
};
export type SqliteNativeTokenOptions = {
  mode: "token-create" | "token-reclaim";
  identity: SqliteStagingTokenIdentity;
  preparationId: number;
};
export type SqliteNativeStagingOptions =
  | { mode: "staging-create" | "staging-create-legacy"; preparationId: number }
  | { mode: "staging-retire" | "staging-reconcile" };
export type SqliteNativeStagingSession = {
  isRetired(): boolean;
  compatible(launch: SqliteNativeSessionLaunch): boolean;
  run(pathname: string, options: SqliteNativeStagingOptions): Promise<string>;
  run(pathname: string, options: SqliteNativeTokenOptions): Promise<SqliteStagingTokenIdentity>;
  settleToken(
    directory: string,
    preparationId: number,
  ): Promise<"retired" | "closed" | "not-started">;
  close(): Promise<void>;
};
export type SqliteNativeCommand =
  | { type: "directory.removed"; directory: string }
  | {
      type: "session.create";
      session: number;
      launch: SqliteNativeSessionLaunch;
      token?: SqliteNativeTokenReservation;
    }
  | ({ type: "session.run"; session: number; pathname: string } & (
      | SqliteNativeStagingOptions
      | SqliteNativeTokenOptions
    ))
  | { type: "session.close"; session: number }
  | { type: "token.settle"; session: number; directory: string; preparationId: number }
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
      | { ok: true; value?: string | SqliteStagingTokenIdentity }
      | { ok: false; error: OpenClawStateWorkerErrorPayload }
    ))
  | { type: "session.closed"; session: number };
