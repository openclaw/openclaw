import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { ChatAbortControllerEntry, ChatAbortOps } from "../chat-abort.js";
import type { ChatAbortRequester } from "./chat-abort-authorization.js";
import type { abortControlledSubagents } from "./chat-abort-descendants.js";
import type { ChatAbortOrigin, ChatAbortSessionSnapshot } from "./chat-aborted-partial.js";
import type { GatewayRequestContext } from "./types.js";

export type ChatSessionEmbeddedAbortOutcome = {
  capturedRunId?: string;
  controller?: ChatAbortControllerEntry;
  wasActive: boolean;
  aborted: boolean;
};

export type ChatSessionAbortParams = {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  sessionKeyAliases?: string[];
  agentId?: string;
  sessionId?: string;
  runId?: string;
  /** Supplied only by narrow admission, from its original materialized target. */
  requiredSessionId?: string;
  session?: ChatAbortSessionSnapshot;
  defaultAgentId?: string;
  abortOrigin: ChatAbortOrigin;
  stopReason?: string;
  requester: ChatAbortRequester;
  assertCurrent?: () => void;
  /**
   * Session Stop owners also stop the controller-less embedded producer and record
   * its cancellation. They must supply their live authority as assertCurrent.
   */
  stopEmbeddedRun?: true;
  preserveSideRuns?: boolean;
  cascadeDescendants?: true;
  /** Exact lifecycle owners may include hidden and side runs for this one session. */
  includeProtectedRuns?: boolean;
  /** Captures exact registrations before cancellation can remove them. */
  onControllerTargets?: (
    targets: Array<{ runId: string; entry: ChatAbortControllerEntry }>,
  ) => void;
  /** Clear lifecycle queues before signaling the embedded producer. */
  onAuthorizedBeforeEmbeddedAbort?: () => boolean;
  /** Internal session-wide cleanup consumes the shared producer's Stop outcome. */
  onAuthorizedAfterQueuedAbort?: (embedded: ChatSessionEmbeddedAbortOutcome) => boolean;
  /** Runs after authorized synchronous abort, before terminal/partial persistence can yield. */
  onCancellationStarted?: () => void;
};

export type ChatSessionAbortResult = {
  aborted: boolean;
  runIds: string[];
  unauthorized: boolean;
  error?: ErrorShape;
  warning?: string;
  descendants?: Awaited<ReturnType<typeof abortControlledSubagents>>;
};
