import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  AgentToAgentPolicy,
  SessionToolsVisibility,
} from "../../plugin-sdk/session-visibility.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { resolveSessionToolAccess } from "./sessions-helpers.js";

export async function resolveSessionsSendAccess(params: {
  readConfig: () => OpenClawConfig;
  watch: boolean;
  sandboxed?: boolean;
  requesterAgentId: string;
  requesterSessionKey: string;
  mainSessionKey?: string;
  targetAgentId: string;
  targetSessionKey: string;
  requesterOwned: boolean;
  visibility: SessionToolsVisibility;
  a2aPolicy: AgentToAgentPolicy;
  callGateway: AgentToolGatewayRequestCaller;
  useRequesterForLiteralSentinel: boolean;
}) {
  const authorizationTargetSessionKey = params.useRequesterForLiteralSentinel
    ? params.requesterSessionKey
    : !parseAgentSessionKey(params.targetSessionKey)
      ? `agent:${params.targetAgentId}:${params.targetSessionKey}`
      : params.targetSessionKey;
  const access = await resolveSessionToolAccess({
    action: "send",
    watch: params.watch,
    readConfig: params.readConfig,
    sandboxed: params.sandboxed,
    requesterAgentId: params.requesterAgentId,
    requesterSessionKey: params.requesterSessionKey,
    mainSessionKey: params.mainSessionKey,
    targetAgentId: params.targetAgentId,
    targetSessionKey: params.targetSessionKey,
    authorizationTargetSessionKey,
    requesterOwned: params.requesterOwned,
    visibility: params.visibility,
    a2aPolicy: params.a2aPolicy,
    callGateway: params.callGateway,
  });
  return { access, authorizationTargetSessionKey };
}
