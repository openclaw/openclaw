import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { describeExecTool } from "../agents/bash-tools.descriptions.js";
import type { ExecToolDefaults } from "../agents/bash-tools.exec-types.js";
import { execSchema } from "../agents/bash-tools.schemas.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicyForSession,
} from "../agents/pi-tools.policy.js";
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
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "../security/dangerous-tools.js";

type GatewayScopedToolSurface = "http" | "loopback";

function createLazyHttpExecTool(opts: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  workspaceDir?: string;
}): AnyAgentTool {
  const globalExec = opts.cfg.tools?.exec;
  const agentExec = opts.agentId
    ? resolveAgentConfig(opts.cfg, opts.agentId)?.tools?.exec
    : undefined;
  const defaults: ExecToolDefaults = {
    host: agentExec?.host ?? globalExec?.host,
    security: agentExec?.security ?? globalExec?.security,
    ask: agentExec?.ask ?? globalExec?.ask,
    pathPrepend: agentExec?.pathPrepend ?? globalExec?.pathPrepend,
    safeBins: agentExec?.safeBins ?? globalExec?.safeBins,
    safeBinTrustedDirs: agentExec?.safeBinTrustedDirs ?? globalExec?.safeBinTrustedDirs,
    strictInlineEval: agentExec?.strictInlineEval ?? globalExec?.strictInlineEval,
    timeoutSec: agentExec?.timeoutSec ?? globalExec?.timeoutSec,
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

export function resolveGatewayScopedTools(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  messageProvider?: string;
  accountId?: string;
  agentTo?: string;
  agentThreadId?: string;
  allowGatewaySubagentBinding?: boolean;
  allowMediaInvokeCommands?: boolean;
  surface?: GatewayScopedToolSurface;
  excludeToolNames?: Iterable<string>;
  disablePluginTools?: boolean;
  senderIsOwner?: boolean;
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
  const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, [
    ...(profileAlsoAllow ?? []),
    ...gatewayRequestedTools,
  ]);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(providerProfilePolicy, [
    ...(providerProfileAlsoAllow ?? []),
    ...gatewayRequestedTools,
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
  const workspaceDir = resolveAgentWorkspaceDir(
    params.cfg,
    agentId ?? resolveDefaultAgentId(params.cfg),
  );

  const allTools = createOpenClawTools({
    agentSessionKey: params.sessionKey,
    agentChannel: params.messageProvider ?? undefined,
    agentAccountId: params.accountId,
    agentTo: params.agentTo,
    agentThreadId: params.agentThreadId,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    allowMediaInvokeCommands: params.allowMediaInvokeCommands,
    disablePluginTools: params.disablePluginTools,
    wrapBeforeToolCallHook: false,
    senderIsOwner: params.senderIsOwner,
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
      gatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : undefined,
    ]),
    pluginToolDenylist: collectExplicitDenylist([
      profilePolicy,
      providerProfilePolicy,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      subagentPolicy,
    ]),
  });

  // Register the agent-side bash exec tool on the HTTP surface so operators
  // can reach it via `POST /tools/invoke`. The standard HTTP deny list still
  // blocks it by default; opting in via `gateway.tools.allow: ["exec"]` is
  // what actually exposes it (mirrors the `nodes` registration contract).
  const surface = params.surface ?? "http";
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
    ],
  });

  const gatewayToolsCfg = params.cfg.gateway?.tools;
  const defaultGatewayDeny =
    surface === "http"
      ? DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter((name) => !gatewayToolsCfg?.allow?.includes(name))
      : [];
  const gatewayDenySet = new Set([
    ...defaultGatewayDeny,
    ...(Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : []),
    ...(params.excludeToolNames ? Array.from(params.excludeToolNames) : []),
  ]);

  return {
    agentId,
    tools: policyFiltered.filter((tool) => !gatewayDenySet.has(tool.name)),
  };
}
