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
import type { TalkAgentConsultAuthority } from "./client-gateway-control.js";

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
