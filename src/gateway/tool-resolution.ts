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
import { buildDeclaredToolAllowlistContext } from "../agents/tool-policy-declared-context.js";
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
import {
  replaceWithEffectiveCronCreatorToolAllowlist,
  type CronCreatorToolAllowlistEntry,
} from "../agents/tools/cron-tool.js";
import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  DEFAULT_GATEWAY_HTTP_TOOL_DENY,
  GATEWAY_OWNER_ONLY_CORE_TOOLS,
} from "../security/dangerous-tools.js";
import { resolveNodeScopedToolPolicy } from "./node-tool-policy.js";

type GatewayScopedToolSurface = "http" | "loopback";

/** Resolve the tools visible to a gateway caller after agent, channel, and surface policy. */
export function resolveGatewayScopedTools(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId?: string;
  onYield?: (message: string) => Promise<void> | void;
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
  const surface = params.surface ?? "http";
  const gatewayToolsCfg = params.cfg.gateway?.tools;
  // gateway.tools.byNode is a RUN-SCOPED restriction for node-originated turns,
  // enforced in the embedded agent tool builder where the authenticated hosting
  // node id is threaded through the run. This scoped resolver serves MCP/HTTP
  // tool callers (not node-originated), so it carries no hosting node → no-op.
  const { nodeAllow, nodeDeny } = resolveNodeScopedToolPolicy(undefined, params.cfg);
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
  const inheritedToolDenylist = [...explicitDenylist, ...nodeDeny];
  // Passed by reference to sessions_spawn and populated after the final policy
  // pass so child sessions inherit the actual parent tool surface.
  const inheritedToolAllowlist: string[] = [];
  const cronCreatorToolAllowlist: CronCreatorToolAllowlistEntry[] = [];
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
    // A byNode allow list narrows the surface too, so spawned subagents must
    // inherit the narrowed allowlist.
    (nodeAllow !== undefined && nodeAllow.length > 0);
  const shouldCaptureCronCreatorToolAllowlist =
    shouldInheritEffectiveToolAllowlist ||
    explicitDenylist.length > 0 ||
    excludedToolNames.length > 0;

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
    sessionId: params.sessionId,
    onYield: params.onYield,
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
    cronCreatorToolAllowlist: shouldCaptureCronCreatorToolAllowlist
      ? cronCreatorToolAllowlist
      : undefined,
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
    declaredToolAllowlist: buildDeclaredToolAllowlistContext({
      config: params.cfg,
      workspaceDir,
      toolDenylist: explicitDenylist,
    }),
  });

  const gatewayDenySet = new Set([
    ...defaultGatewayDeny,
    ...ownerOnlyGatewayDeny,
    ...(Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : []),
    ...excludedToolNames,
    ...nodeDeny,
  ]);
  const denyFiltered = policyFiltered.filter((tool) => !gatewayDenySet.has(tool.name));

  // byNode allow list applies after the full policy pipeline + gatewayDenySet and
  // can only narrow. An explicitly-present allow (even empty) is fail-CLOSED:
  // empty => no tools. An ABSENT allow means "no allow restriction".
  const allowSet = nodeAllow ? new Set(nodeAllow) : undefined;
  const tools = allowSet ? denyFiltered.filter((tool) => allowSet.has(tool.name)) : denyFiltered;

  // Capture the inherited allowlist from the FINAL (byNode-restricted) set so
  // spawned subagents inherit the narrowed surface, not the unrestricted parent.
  if (shouldInheritEffectiveToolAllowlist) {
    replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, tools);
  }
  if (shouldCaptureCronCreatorToolAllowlist) {
    replaceWithEffectiveCronCreatorToolAllowlist(cronCreatorToolAllowlist, tools, (tool) =>
      getPluginToolMeta(tool),
    );
  }

  return {
    agentId,
    tools,
  };
}
