import type { readSessionEntrySummariesInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { listOrphanedSessionPendingInputTargets } from "../config/sessions/session-pending-input-withdrawal.js";
import type { Deferred } from "../shared/deferred.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

export type RestartResumeClaim = ((target: {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  sourceRunId?: string;
  queuedInputIds: readonly string[];
}) => Promise<boolean>) & {
  /** Existing maintenance custody to exclude from ordinary orphan cancellation. */
  queuedInputIds?: (
    target: Pick<RestartStoreTarget, "storePath" | "physicalAgentId" | "env">,
  ) => Promise<readonly string[]>;
};

export type RestartResumeParams = {
  context: GatewayRequestContext;
  signal: AbortSignal;
  log: { warn: (message: string) => void };
  /** A durable maintenance owner records queue custody before this owner retires its marker. */
  claimResume?: RestartResumeClaim;
};

export type RestartStoreTarget = {
  agentId: string;
  physicalAgentId: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
};
export type PreparedRestartStore = {
  target: RestartStoreTarget;
  entries: Awaited<ReturnType<typeof readSessionEntrySummariesInWorker>>;
  orphaned: Awaited<ReturnType<typeof listOrphanedSessionPendingInputTargets>>;
};

export type RecoveryState = {
  ready: Deferred;
  allowUnmarked: boolean;
  claimResume?: RestartResumeClaim;
  stores: Map<string, Promise<void>>;
};
