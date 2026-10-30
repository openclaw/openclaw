import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";

export type AgentStepSession = {
  sessionId: string;
  lifecycleRevision?: string;
};

export type SessionsSendToolOptions = {
  swarmCollector?: boolean;
  modelProvider?: string;
  modelId?: string;
  sessionId?: string;
  runId?: string;
  onYield?: import("./sessions-yield-tool.js").SessionsYieldCallback;
  senderIsOwner?: boolean;
  scheduledToolTargets?: import("../../cron/execution-context-registry.js").ScheduledToolTargets;
  expectedTargetTask?: Omit<
    import("../../gateway/in-process-subagent-resume.js").TrustedSubagentResume,
    "caller"
  >;
  expectedTargetLifecycleRevision?: string | null;
  expectedTargetRun?: Pick<
    import("../subagents/registry/subagent-registry.types.js").SubagentRunRecord,
    "runId" | "taskRunId" | "generation" | "createdAt"
  > | null;
  /** A retained replay uses its host-owned source assertion and cannot ask for fresh approval. */
  retainedReplay?: true;
  workerPlacement?: boolean;
  agentId?: string;
  agentSessionKey?: string;
  agentSessionId?: string;
  requesterTurnRunId?: string;
  inheritedToolPolicySource?: "sender";
  agentChannel?: string;
  requesterOrigin?: DeliveryContext;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: AgentToolGatewayRequestCaller;
  /** Backend-derived target incarnation; never sourced from model arguments. */
  expectedTargetSessionId?: string;
  expectedTargetStorePath?: string;
  /** Host adapter owns delivery/completion; not a model-facing option or an identity fence. */
  completionOwner?: "caller";
  /** Backend-owned downstream operation id; never sourced from model arguments. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Current host/worker source authority; never model input. */
  assertSourceCurrent?: () => void;
};
