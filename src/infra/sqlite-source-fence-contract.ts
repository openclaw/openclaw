import type { DatabaseSync } from "node:sqlite";
import type { DatabasePathIdentity } from "./sqlite-worker-identity.js";

/** Captured by the physical owner; an incarnation is never reused after closure. */
export type SqliteSourceFenceIdentity = {
  physical: DatabasePathIdentity;
  incarnation: string;
};

export type SqliteSourceFenceDatabase = {
  readonly identity: SqliteSourceFenceIdentity;
  readonly database: DatabaseSync;
};

/** Worker-local kernels only. Host closures never execute inside the reservation interval. */
export type SqliteSourceFence = {
  destination: SqliteSourceFenceDatabase;
  sources: readonly SqliteSourceFenceDatabase[];
  validate(resolve: (source: SqliteSourceFenceDatabase) => DatabaseSync): void;
};

export const SQLITE_WORKER_SOURCE_FENCE = Symbol.for("openclaw.sqliteWorkerSourceFence");

export const SOURCE_FENCE_READY = 1;
export const SOURCE_FENCE_ACCEPTED = 2;

export type SqliteSourceFenceGrant = {
  kind: "sqlite-source-fence";
  version: 1;
  decision: SharedArrayBuffer;
  destination: SqliteSourceFenceIdentity;
  sources: readonly SqliteSourceFenceIdentity[];
  deadlineNs: bigint;
};
