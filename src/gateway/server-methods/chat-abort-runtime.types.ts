import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionTarget } from "../../sessions/session-controller.lifecycle.js";
import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
import type {
  SessionStopHookContext,
  SessionStopSource,
} from "../../sessions/session-controller.stop.js";
import type { ChatAbortOps } from "../chat-abort.js";
import type { ChatAbortRequester } from "./chat-abort-authorization.js";
import type { abortControlledSubagents } from "./chat-abort-descendants.js";
import type { ChatAbortOrigin, ChatAbortSessionSnapshot } from "./chat-aborted-partial.js";
import type { GatewayRequestContext } from "./types.js";

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
  stopSource: SessionStopSource;
  hookContext?: SessionStopHookContext;
  controllerTargets?: readonly SessionTarget[];
  requester: ChatAbortRequester;
  assertCurrent?: () => void;
  /** Prepare persisted request facts immediately before the synchronous cancellation effects. */
  beforeAbort?: () => Promise<void>;
  preserveSideRuns?: boolean;
  cascadeDescendants?: true;
  /** Exact lifecycle owners may include hidden and side runs for this one session. */
  includeProtectedRuns?: boolean;
  /** Captures exact registrations before cancellation can remove them. */
  onControllerTargets?: (targets: Array<{ runId: string; entry: RpcSourceRef }>) => void;
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
