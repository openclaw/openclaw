import type { AgentWaitParams } from "../../packages/gateway-protocol/src/index.js";
import type { RuntimeContextFragment } from "../agents/internal-runtime-context.js";
import type { SubagentCompletionToolHandoffRegistration } from "../agents/subagents/announce/subagent-announce-handoff.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import type {
  AgentTurnStartOwner,
  InternalAgentTurnFacadeFactory,
} from "./agent-turn/internal-facade.types.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";

export type GatewayInstanceAgentDispatchOptions = {
  allowModelOverride?: boolean;
  allowSyntheticModelOverride?: boolean;
  allowSyntheticCronRunContinuation?: boolean;
  delegatedToolPolicyHandoff?: SubagentCompletionToolHandoffRegistration;
  expectFinal?: boolean;
  /** Instance-owned dispatch always uses a synthetic client. */
  forceSyntheticClient?: boolean;
  internalDeliveryMediaUrls?: string[];
  runtimeContextFragments?: RuntimeContextFragment[];
  internalDeliverySuppressText?: boolean;
  onAccepted?: (payload: unknown) => void;
  onStartOwner?: (owner: AgentTurnStartOwner) => void;
  onExecutionStarted?: () => void;
  onSignalAbort?: () => Promise<void> | void;
  scopes?: string[];
  signal?: AbortSignal;
  syntheticScopes?: string[];
};

export type GatewayApprovalEventPublisher = {
  publishRequested: (kind: ChannelApprovalKind, request: unknown) => number;
  publishResolved: (kind: ChannelApprovalKind, resolved: unknown) => void;
};

export type GatewayRecoveryTypingParams = {
  agentId?: string;
  runId: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
  isCurrent: (cfg: OpenClawConfig) => boolean;
};

export type GatewayRecoveryRuntime = {
  startRecoveryTyping?: (params: GatewayRecoveryTypingParams) => () => void;
  dispatchAgent: <T = unknown>(
    params: AgentRunRequest,
    timeoutMs?: number,
    options?: GatewayInstanceAgentDispatchOptions,
  ) => Promise<T>;
  waitForAgent: <T = unknown>(params: AgentWaitParams, timeoutMs?: number) => Promise<T>;
  sendRecoveryNotice: (
    params: {
      channel: string;
      to: string;
      accountId?: string;
      threadId?: string | number;
      text: string;
      idempotencyKey: string;
    } & (
      | {
          /** Main-session announcements cannot outlive their process-local owner. */
          liveOnly: true;
          isCurrent: (cfg: OpenClawConfig) => boolean;
        }
      | {
          /** Existing callers retain durable retry and deduplication by default. */
          liveOnly?: false;
          isCurrent?: (cfg: OpenClawConfig) => boolean;
        }
    ),
  ) => Promise<{
    /** True when delivery produced zero platform results (policy/channel suppression). */
    suppressed: boolean;
  }>;
};

export type GatewayInstanceRuntime = {
  createAgentTurnFacade: InternalAgentTurnFacadeFactory;
  approvalEvents: GatewayApprovalEventPublisher;
  nativeApprovals: GatewayNativeApprovalRuntime;
  recovery: GatewayRecoveryRuntime;
  isAvailable: () => boolean;
  close: () => void;
};
