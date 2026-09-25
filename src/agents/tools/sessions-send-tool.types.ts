import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { InheritedToolPolicySourceCapture } from "../inherited-tool-policy.schema.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";

export type SessionsSendToolOptions = {
  agentId?: string;
  agentSessionKey?: string;
  agentSessionId?: string;
  agentChannel?: string;
  requesterOrigin?: DeliveryContext;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: AgentToolGatewayRequestCaller;
  /** Host-prepared restrictions of the current tool generation; never model arguments. */
  captureInheritedToolPolicyForDelegation?: InheritedToolPolicySourceCapture;
  /** Backend-derived target incarnation; never sourced from model arguments. */
  expectedTargetSessionId?: string;
  /** Backend-owned downstream operation id; never sourced from model arguments. */
  idempotencyKey?: string;
  signal?: AbortSignal;
};
