import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";

export type SessionsSendToolOptions = {
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
