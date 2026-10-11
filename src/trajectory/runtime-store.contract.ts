import type { TrajectoryEvent } from "./types.js";

export type SqliteTrajectoryRuntimeScope = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  maxGlobalRuntimeBytes?: number;
  maxRuntimeBytes?: number;
  sessionId: string;
  storePath: string;
  assertCommitAllowed?: () => void;
};

export type SqliteTrajectoryRuntimeAppend = Pick<
  SqliteTrajectoryRuntimeScope,
  "sessionId" | "maxRuntimeBytes" | "maxGlobalRuntimeBytes"
> & {
  events: readonly TrajectoryEvent[];
  /** The queued prefix exceeded this session's rolling window before admission. */
  discardPrevious?: boolean;
};

export type SqliteTrajectoryRuntimeReadScope = Omit<
  SqliteTrajectoryRuntimeScope,
  "assertCommitAllowed" | "maxGlobalRuntimeBytes" | "maxRuntimeBytes"
> & {
  /** Byte budget enforced via SQL before parsing rows; ignored for tail-bounded reads. */
  maxEventBytes?: number;
  /** Row-count budget enforced via SQL before parsing rows; ignored for tail-bounded reads. */
  maxEventCount?: number;
};
