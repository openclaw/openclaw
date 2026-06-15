// Gateway-scoped tool resolution for HTTP and loopback tool surfaces.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../agents/agent-tools.policy.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../agents/subagent-capabilities.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../agents/tool-policy-pipeline.js";
import {
  collectExplicitAllowlist,
  collectExplicitDenylist,
  hasRestrictiveAllowPolicy,
  mergeAlsoAllowPolicy,
  replaceWithEffectiveToolAllowlist,
  resolveToolProfilePolicy,
} from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  DEFAULT_GATEWAY_HTTP_TOOL_DENY,
  GATEWAY_OWNER_ONLY_CORE_TOOLS,
} from "../security/dangerous-tools.js";

type GatewayScopedToolSurface = "http" | "loopback";

/** Resolve the tools visible to a gateway caller after agent, channel, and surface policy. */
export function resolveGatewayScopedTools(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  messageProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentInboundAudio?: boolean;
  accountId?: string;
  inboundEventKind?: InboundEventKind;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  requireExplicitMessageTarget?: boolean;
  agentTo?: string;
  agentThreadId?: string;
  senderIsOwner?: boolean;
  allowGatewaySubagentBinding?: boolean;
  allowMediaInvokeCommands?: boolean;
  surface?: GatewayScopedToolSurface;
  excludeToolNames?: Iterable<string>;
  /**
   * When non-empty, restricts the FINAL returned tools to only these names
   * (applied after the full policy pipeline + gatewayDenySet). This is a
   * RESTRICTION-only intersection: it can never add a tool that the existing
   * policy already removed, so it is safe even if the value originates from an
   * untrusted client (e.g. a connecting client's self-reported client.id).
   */
  allowToolNames?: Iterable<string>;
  /**
   * Deny names (e.g. from a byClientId restriction) that must ALSO propagate to
   * spawned subagents — added to the inherited denylist, not only the parent
   * gatewayDenySet — so the restriction cannot be escaped via sessions_spawn.
   */
  inheritedDenyToolNames?: Iterable<string>;
  disablePluginTools?: boolean;
  gatewayRequestedTools?: string[];
}) {
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({ config: params.cfg, sessionKey: params.sessionKey });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const gatewayRequestedTools = params.gatewayRequestedTools ?? [];
  const messageProvider = params.messageProvider?.trim().toLowerCase();
  const sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined =
    params.sourceReplyDeliveryMode ??
    (params.inboundEventKind === "room_event" && messageProvider !== "webchat"
      ? "message_tool_only"
      : undefined);
  const runtimeAlsoAllow = sourceReplyDeliveryMode === "message_tool_only" ? ["message"] : [];
  const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, [
    ...(profileAlsoAllow ?? []),
    ...gatewayRequestedTools,
    ...runtimeAlsoAllow,
  ]);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(providerProfilePolicy, [
    ...(providerProfileAlsoAllow ?? []),
    ...gatewayRequestedTools,
    ...runtimeAlsoAllow,
  ]);
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    accountId: params.accountId ?? null,
  });
  const subagentStore = resolveSubagentCapabilityStore(params.sessionKey, {
    cfg: params.cfg,
  });
  const subagentPolicy = isSubagentEnvelopeSession(params.sessionKey, {
    cfg: params.cfg,
    store: subagentStore,
  })
    ? resolveSubagentToolPolicyForSession(params.cfg, params.sessionKey, {
        store: subagentStore,
      })
    : undefined;
  const inheritedToolPolicy = resolveInheritedToolPolicyForSession(params.cfg, params.sessionKey, {
    store: subagentStore,
  });
  const excludedToolNames = params.excludeToolNames ? Array.from(params.excludeToolNames) : [];
  const byClientIdAllow = params.allowToolNames ? Array.from(params.allowToolNames) : undefined;
  const inheritedDenyToolNames = params.inheritedDenyToolNames
    ? Array.from(params.inheritedDenyToolNames)
    : [];
  const surface = params.surface ?? "http";
  const gatewayToolsCfg = params.cfg.gateway?.tools;
  const defaultGatewayDeny =
    surface === "http"
      ? DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter((name) => !gatewayToolsCfg?.allow?.includes(name))
      : [];
  const ownerOnlyGatewayDeny =
    params.senderIsOwner === false || (surface === "http" && params.senderIsOwner !== true)
      ? [...GATEWAY_OWNER_ONLY_CORE_TOOLS]
      : [];
  // HTTP callers start with additional surface denies because they cross auth only.
  const workspaceDir = resolveAgentWorkspaceDir(
    params.cfg,
    agentId ?? resolveDefaultAgentId(params.cfg),
  );
  const explicitDenylist = collectExplicitDenylist([
    profilePolicy,
    providerProfilePolicy,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    subagentPolicy,
    inheritedToolPolicy,
    defaultGatewayDeny.length > 0 ? { deny: defaultGatewayDeny } : undefined,
    ownerOnlyGatewayDeny.length > 0 ? { deny: ownerOnlyGatewayDeny } : undefined,
    Array.isArray(gatewayToolsCfg?.deny) ? { deny: gatewayToolsCfg.deny } : undefined,
  ]);
  const inheritedToolDenylist = [...explicitDenylist, ...inheritedDenyToolNames];
  // Passed by reference to sessions_spawn and populated after the final policy
  // pass so child sessions inherit the actual parent tool surface.
  const inheritedToolAllowlist: string[] = [];
  const shouldInheritEffectiveToolAllowlist =
    [
      profilePolicy,
      providerProfilePolicy,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      subagentPolicy,
      inheritedToolPolicy,
      gatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : undefined,
    ].some(hasRestrictiveAllowPolicy) ||
    // A byClientId allow list narrows the surface too, so spawned subagents must
    // inherit the narrowed allowlist (not just the direct loopback turn).
    (byClientIdAllow !== undefined && byClientIdAllow.length > 0);

  const allTools = createOpenClawTools({
    agentSessionKey: params.sessionKey,
    agentChannel: params.messageProvider ?? undefined,
    agentAccountId: params.accountId,
    inboundEventKind: params.inboundEventKind,
    sourceReplyDeliveryMode,
    agentTo: params.agentTo,
    agentThreadId: params.agentThreadId,
    currentChannelId: params.currentChannelId ?? params.agentTo,
    currentThreadTs: params.currentThreadTs ?? params.agentThreadId,
    currentMessageId: params.currentMessageId,
    currentInboundAudio: params.currentInboundAudio,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    senderIsOwner: params.senderIsOwner,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    allowMediaInvokeCommands: params.allowMediaInvokeCommands,
    disablePluginTools: params.disablePluginTools,
    wrapBeforeToolCallHook: false,
    config: params.cfg,
    workspaceDir,
    pluginToolAllowlist: collectExplicitAllowlist([
      profilePolicy,
      providerProfilePolicy,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      subagentPolicy,
      inheritedToolPolicy,
      gatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : undefined,
    ]),
    pluginToolDenylist: explicitDenylist,
    inheritedToolAllowlist,
    inheritedToolDenylist,
  });

  const policyFiltered = applyToolPolicyPipeline({
    tools: allTools,
    toolMeta: (tool: AnyAgentTool) => getPluginToolMeta(tool),
    warn: logWarn,
    steps: [
      ...buildDefaultToolPolicyPipelineSteps({
        profilePolicy: profilePolicyWithAlsoAllow,
        profile,
        profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
        providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
        providerProfile,
        providerProfileUnavailableCoreWarningAllowlist: providerProfilePolicy?.allow,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        agentId,
      }),
      { policy: subagentPolicy, label: "subagent tools.allow" },
      { policy: inheritedToolPolicy, label: "inherited tools" },
    ],
  });

  const gatewayDenySet = new Set([
    ...defaultGatewayDeny,
    ...ownerOnlyGatewayDeny,
    ...(Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : []),
    ...excludedToolNames,
  ]);
  const denyFiltered = policyFiltered.filter((tool) => !gatewayDenySet.has(tool.name));

  // byClientId restriction applies after the full policy pipeline + gatewayDenySet.
  // An explicitly-present allow list (even empty) is fail-CLOSED: empty => no tools.
  // Only an ABSENT allow list means "no restriction".
  const allowSet = byClientIdAllow ? new Set(byClientIdAllow) : undefined;
  const tools = allowSet ? denyFiltered.filter((tool) => allowSet.has(tool.name)) : denyFiltered;

  // Capture the inherited allowlist from the FINAL (byClientId-restricted) set so
  // spawned subagents inherit the narrowed surface, not the unrestricted parent.
  if (shouldInheritEffectiveToolAllowlist) {
    replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, tools);
  }

  return {
    agentId,
    tools,
  };
}
