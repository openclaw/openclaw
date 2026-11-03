import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { resolveAgentConfig } from "../../agents/agent-scope-config.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { resolveEmbeddedFullAccessState } from "../../agents/embedded-agent-runner/sandbox-info.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { resolveReplyExecOverrides } from "../../auto-reply/reply/get-reply-exec-overrides.js";
import { resolveElevatedPermissions } from "../../auto-reply/reply/reply-elevated.js";
import { resolveInboundReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-tool-authority.js";
import { normalizeElevatedLevel } from "../../auto-reply/thinking.shared.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRealtimeVoiceAgentConsultToolsAllow } from "../../talk/agent-consult-tool.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import { resolveChatSendCallerContext } from "../server-methods/gateway-client-identity.js";

export type TalkAgentConsultAuthority = {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  senderIsOwner: boolean;
  toolsAllow?: string[];
  replyCaller?: ReturnType<typeof resolveChatSendCallerContext>;
};

export function resolveTalkAgentConsultAuthority(
  scopes: readonly string[] | undefined,
  client?: Parameters<typeof resolveChatSendCallerContext>[0],
): TalkAgentConsultAuthority {
  const senderIsOwner = scopes?.includes(ADMIN_SCOPE) === true;
  const replyCaller = client ? resolveChatSendCallerContext(client) : undefined;
  if (replyCaller) {
    // Talk has no task-suggestion acceptance UI, even when its hosting client does.
    replyCaller.GatewayClientCaps = replyCaller.GatewayClientCaps.filter(
      (cap) => cap !== GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS,
    );
  }
  if (senderIsOwner || scopes?.includes(WRITE_SCOPE) === true) {
    return { senderIsOwner, ...(replyCaller ? { replyCaller } : {}) };
  }
  return {
    senderIsOwner: false,
    ...(replyCaller ? { replyCaller } : {}),
    toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow("safe-read-only"),
  };
}

/** Adapt the authenticated caller, not ASR text or a previous delivery route. */
export function prepareTalkClientToolContext(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionEntry?: SessionEntry;
  authority: TalkAgentConsultAuthority;
}) {
  const ctx = params.authority.replyCaller;
  if (!ctx) {
    return undefined;
  }
  const senderIsOwner = resolveCommandAuthorization({
    ctx,
    cfg: params.config,
    commandAuthorized: false,
  }).senderIsOwner;
  const toolAuthorityOverlay = resolveInboundReplyToolAuthorityOverlay({
    ctx,
    sessionEntry: params.sessionEntry,
    senderIsOwner,
    operatorAuthority: params.authority.operatorAuthority,
    toolsAllow: params.authority.toolsAllow,
    disableTools: false,
  });
  const elevated = resolveElevatedPermissions({
    cfg: params.config,
    agentId: params.agentId,
    ctx,
    provider: ctx.Provider,
  });
  const bashElevated: NonNullable<RunEmbeddedAgentParams["bashElevated"]> = {
    enabled: elevated.enabled,
    allowed: elevated.allowed,
    defaultLevel: elevated.allowed
      ? (normalizeElevatedLevel(params.sessionEntry?.elevatedLevel) ??
        normalizeElevatedLevel(params.config.agents?.defaults?.elevatedDefault) ??
        "on")
      : "off",
  };
  const fullAccess = resolveEmbeddedFullAccessState({ execElevated: bashElevated });
  return {
    toolAuthorityOverlay,
    execOverrides: resolveReplyExecOverrides({
      sessionEntry: params.sessionEntry,
      agentExecDefaults: resolveAgentConfig(params.config, params.agentId)?.tools?.exec,
    }),
    bashElevated: {
      ...bashElevated,
      fullAccessAvailable: fullAccess.available,
      ...(fullAccess.blockedReason ? { fullAccessBlockedReason: fullAccess.blockedReason } : {}),
    },
  };
}
