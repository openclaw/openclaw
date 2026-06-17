// Gateway-scoped tool resolution for HTTP and loopback tool surfaces.

import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { createOpenClawCodingToolsRaw } from "../agents/agent-tools.js";
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
  const cronCreatorToolAllowlist: CronCreatorToolAllowlistEntry[] = [];
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

  // Wire the `read` coding tool into the gateway direct-invoke surfaces so it
  // is reachable for deterministic automation (CI/preflight checks, lint,
  // browser capture flows) without a full LLM round-trip. Narrow first landing
  // of the broader direct-invoke umbrella tracked in #37131.
  //
  // **Triple-key gating** (addresses ClawSweeper [P1] + the non-owner
  // authorization finding on PR #85664):
  // - `surface === "http"` — the **direct-invoke marker** set by
  //   `tools-invoke-shared.ts` for BOTH HTTP `POST /tools/invoke` AND SDK-facing
  //   JSON-RPC `tools.invoke` (they share the resolver). MCP loopback uses
  //   `surface === "loopback"` and is unaffected.
  // - `gateway.tools.directInvoke.hostFsRead: true` — the NEW distinct opt-in.
  //   Without this, the read tool is NOT materialized into the candidate set,
  //   so existing configs that have `gateway.tools.allow: ["read"]` for
  //   unrelated reasons (e.g. an MCP/agent surface where `read` is already
  //   available) stay inert. This prevents an upgrade-time compatibility
  //   break.
  // - `params.senderIsOwner === true` — the **owner gate**. Host-filesystem
  //   read is an owner/admin-only capability, so it must NOT be materialized for
  //   a non-owner direct-invoke caller. On the HTTP/RPC surface a shared-secret
  //   bearer caller resolves to owner (`senderIsOwner === true`), while a
  //   trusted-proxy operator without `ADMIN_SCOPE` resolves to `false`. This
  //   mirrors the fail-closed owner semantics used for `ownerOnlyGatewayDeny`
  //   above (line 130): on HTTP, anything other than an explicit `true` is
  //   treated as non-owner. Without this key a `gateway.auth.mode="trusted-proxy"`
  //   `operator.write` caller could read host files it should never reach.
  // - `gateway.tools.allow: ["read"]` — separately required, lifts `"read"`
  //   from `DEFAULT_GATEWAY_HTTP_TOOL_DENY` so the policy pipeline (line 186)
  //   doesn't filter it out. This key keeps the explicit operator
  //   acceptance step visible in the standard policy surface.
  //
  // Only `read` is materialized — write/edit/exec/process are NOT exposed by
  // this PR. Maintainer approval for opt-in mutating coding primitives is
  // deferred to a follow-up PR.
  //
  // Uses `createOpenClawCodingToolsRaw` (unwrapped) — `handleToolsInvokeHttp`
  // already calls `runBeforeToolCallHook` itself before dispatch, so the
  // tools must arrive unwrapped to avoid double-firing the hook and leaking
  // adjusted-params state.
  //
  // Construction plan limits the factory to just the base coding tool family
  // (read/write/edit/apply_patch) — no shell (exec/process), no channel,
  // OpenClaw, or plugin tools. Then we filter to `read`.
  const allowHostFsReadOverDirectInvoke =
    surface === "http" &&
    params.cfg.gateway?.tools?.directInvoke?.hostFsRead === true &&
    params.senderIsOwner === true;
  const codingTools = allowHostFsReadOverDirectInvoke
    ? createOpenClawCodingToolsRaw({
        agentId: agentId ?? resolveDefaultAgentId(params.cfg),
        sessionKey: params.sessionKey,
        workspaceDir,
        agentDir: resolveAgentDir(params.cfg, agentId ?? resolveDefaultAgentId(params.cfg)),
        config: params.cfg,
        toolConstructionPlan: {
          includeBaseCodingTools: true,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: false,
        },
      }).filter((tool) => tool.name === "read")
    : [];

  // Coding built-ins take precedence on name collision when the host-read
  // opt-in is active, ensuring `read` resolves to the built-in filesystem tool
  // documented by the opt-in/audit surface rather than a same-named plugin.
  // When the opt-in is inactive, `codingTools` is empty so `allTools` is
  // returned unchanged (no behavior change for existing configs).
  const codingToolNames = new Set(codingTools.map((t) => t.name));
  const allToolsWithCoding = [
    ...codingTools,
    ...allTools.filter((t) => !codingToolNames.has(t.name)),
  ];

  const policyFiltered = applyToolPolicyPipeline({
    tools: allToolsWithCoding,
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
  ]);
  const tools = policyFiltered.filter((tool) => !gatewayDenySet.has(tool.name));
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
