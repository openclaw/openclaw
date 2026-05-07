// Gateway-scoped tool resolution for HTTP and loopback tool surfaces.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../agents/agent-tools.policy.js";
import { describeExecTool } from "../agents/bash-tools.descriptions.js";
import type { ExecToolDefaults } from "../agents/bash-tools.exec-types.js";
import { execSchema } from "../agents/bash-tools.schemas.js";
import { resolveExecConfig } from "../agents/exec-config-resolution.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../agents/subagent-capabilities.js";
import { EXEC_TOOL_DISPLAY_SUMMARY } from "../agents/tool-description-presets.js";
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

function createLazyHttpExecTool(opts: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  workspaceDir?: string;
}): AnyAgentTool {
  const execConfig = resolveExecConfig({ cfg: opts.cfg, agentId: opts.agentId });
  const defaults: ExecToolDefaults = {
    host: execConfig.host,
    security: execConfig.security,
    ask: execConfig.ask,
    node: execConfig.node,
    pathPrepend: execConfig.pathPrepend,
    safeBins: execConfig.safeBins,
    safeBinTrustedDirs: execConfig.safeBinTrustedDirs,
    safeBinProfiles: execConfig.safeBinProfiles,
    strictInlineEval: execConfig.strictInlineEval,
    backgroundMs: execConfig.backgroundMs,
    timeoutSec: execConfig.timeoutSec,
    approvalRunningNoticeMs: execConfig.approvalRunningNoticeMs,
    notifyOnExit: execConfig.notifyOnExit,
    notifyOnExitEmptySuccess: execConfig.notifyOnExitEmptySuccess,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    cwd: opts.workspaceDir,
    // HTTP /tools/invoke is synchronous request/response; backgrounding would
    // orphan the process with no transcript to follow up on.
    allowBackground: false,
  };

  let loadedTool: AnyAgentTool | undefined;
  const loadTool = async () => {
    if (!loadedTool) {
      const { createExecTool } = await import("../agents/bash-tools.js");
      loadedTool = createExecTool(defaults) as unknown as AnyAgentTool;
    }
    return loadedTool;
  };

  return {
    name: "exec",
    label: "exec",
    displaySummary: EXEC_TOOL_DISPLAY_SUMMARY,
    description: describeExecTool({ agentId: opts.agentId, hasCronTool: false }),
    parameters: execSchema,
    // Mirrors the `nodes` exec_capable owner-only contract: trusted-proxy
    // callers must have `operator.admin` to reach this. Shared-secret bearer
    // auth always resolves to owner per the /tools/invoke security boundary.
    ownerOnly: true,
    execute: async (...args: Parameters<NonNullable<AnyAgentTool["execute"]>>) =>
      (await loadTool()).execute(...args),
  } as AnyAgentTool;
}

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
  const inheritedToolDenylist = [...explicitDenylist];
  // Passed by reference to sessions_spawn and populated after the final policy
  // pass so child sessions inherit the actual parent tool surface.
  const inheritedToolAllowlist: string[] = [];
  const shouldInheritEffectiveToolAllowlist = [
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
  ].some(hasRestrictiveAllowPolicy);

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

  // Register the agent-side bash exec tool on the HTTP surface so operators
  // can reach it via `POST /tools/invoke`. The standard HTTP deny list still
  // blocks it by default; opting in via `gateway.tools.allow: ["exec"]` is
  // what actually exposes it (mirrors the `nodes` registration contract).
  const httpScopedTools: AnyAgentTool[] =
    surface === "http"
      ? [
          ...allTools,
          createLazyHttpExecTool({
            cfg: params.cfg,
            agentId,
            sessionKey: params.sessionKey,
            workspaceDir,
          }),
        ]
      : allTools;

  const policyFiltered = applyToolPolicyPipeline({
    tools: httpScopedTools,
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
  const tools = policyFiltered.filter((tool) => !gatewayDenySet.has(tool.name));
  if (shouldInheritEffectiveToolAllowlist) {
    replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, tools);
  }

  return {
    agentId,
    tools,
  };
}
