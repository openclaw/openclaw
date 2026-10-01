import type { MessagePort } from "node:worker_threads";
import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
import type { RetainedOperation } from "./retained-operation.js";
import type { SqliteStagingTokenIdentity } from "./sqlite-staging-token.js";
import type { DatabaseFileIdentity } from "./sqlite-worker-identity.js";

export type SqliteSnapshotStagingDirectory = {
  directory: string;
  startRetire: () => RetainedOperation<void>;
};

export type SqliteSnapshotStagingLaunch = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  transport: { kind: "native" };
};

type SqliteSnapshotStagingAllocation = {
  root: string;
  allowLegacyWorker: boolean;
  launch: SqliteSnapshotStagingLaunch;
};

type SnapshotInput = SqliteSnapshotStagingAllocation &
  (
    | { type: "allocate" }
    | {
        type: "prepare";
        pathname: string;
        preserveSourceArtifacts: boolean;
        expectedSourceIdentity?: DatabaseFileIdentity;
        deadlineOwnedByCaller: boolean;
        abortPort?: MessagePort;
      }
  );

export type SqliteSnapshotStagingInput =
  | SnapshotInput
  | {
      type: "token";
      directory: string;
      mode: "create" | "reclaim";
      identity: SqliteStagingTokenIdentity;
      launch: SqliteSnapshotStagingLaunch;
    };

export type WorkerOwnedSqliteStagingToken = Readonly<{
  identity: SqliteStagingTokenIdentity;
  isCurrent: () => boolean;
  retire: () => Promise<void>;
  close: () => Promise<void>;
}>;

export type WorkerOwnedSqliteStagingTokenAdmission =
  RetainedOperation<WorkerOwnedSqliteStagingToken> & {
    readonly identity: SqliteStagingTokenIdentity;
    startClose(): RetainedOperation<void>;
    startRelease(): RetainedOperation<void>;
  };

export type SqliteSnapshotStagingReply =
  | { type: "token"; directory: string; identity: SqliteStagingTokenIdentity }
  | { type: "allocated"; directory: string }
  | { type: "prepared"; directory: string; location: string }
  | {
      type: "failed";
      error: OpenClawStateWorkerErrorPayload;
      cleanupFailure?: true;
      directory?: string;
    };

export type SqliteSnapshotStagingCommand = SqliteSnapshotStagingInput & {
  preparationId: number;
};

export type SqliteSnapshotStagingRequest = RetainedOperation<
  Exclude<SqliteSnapshotStagingReply, { type: "failed" }>
> & {
  startClose(): RetainedOperation<void>;
  startRelease?(): RetainedOperation<void>;
  readonly token?: WorkerOwnedSqliteStagingToken;
};

export type SqliteStagingOwnedDirectory = SqliteSnapshotStagingDirectory & {
  kind: "snapshot";
};

export type SqliteStagingOwnedToken = {
  kind: "token";
  directory: string;
  preparationId: number;
  identity: SqliteStagingTokenIdentity;
  mode: "create" | "reclaim";
  admitted: boolean;
  unavailable: boolean;
  intent?: "retire" | "close";
  terminal?: "retired" | "closed" | "not-started";
  token: WorkerOwnedSqliteStagingToken;
  startSettlement: (intent: "retire" | "close") => RetainedOperation<void>;
  serviceClose: () => void;
};

export type SqliteStagingNativeDirectory = {
  kind: "snapshot" | "token";
  owner: { disposed: boolean };
  preparationId: number;
  removed: boolean;
  recovering: boolean;
};
export type SqliteStagingPreparation = {
  directories: Set<string>;
  closeRequested: boolean;
  isAdmitted(): boolean;
  acceptOwner(owner: { disposed: boolean }): void;
  startClose(): RetainedOperation<void>;
  serviceClose(): void;
  releaseIfComplete(): void;
};
