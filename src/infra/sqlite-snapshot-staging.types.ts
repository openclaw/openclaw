import type { MessagePort } from "node:worker_threads";
import type { RetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
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

export type SqliteSnapshotStagingInput = SqliteSnapshotStagingAllocation &
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

export type SqliteSnapshotStagingReply =
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
};
