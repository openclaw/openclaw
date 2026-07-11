// Gateway-scoped tool resolution for HTTP and loopback tool surfaces.

import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { filterToolsByMessageProvider } from "../agents/agent-tools.message-provider-policy.js";
import { createOpenClawCodingToolsRaw } from "../agents/agent-tools.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../agents/agent-tools.policy.js";
import type { ExecElevatedDefaults } from "../agents/bash-tools.exec-types.js";
import { nodeExecSchema } from "../agents/bash-tools.schemas.js";
import {
  resolveExecDefaults,
  type ExecPolicyOverrides,
  type ExecSessionDefaults,
} from "../agents/exec-defaults.js";
import { createLazyExecTool, resolveExecToolConfig } from "../agents/lazy-exec-tool.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { resolveSenderToolPolicy } from "../agents/sender-tool-policy.js";
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
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { ConversationReadInvocationOrigin } from "../channels/plugins/conversation-read-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import { logWarn } from "../logger.js";
import type { PluginHookChannelContext } from "../plugins/hook-types.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  DEFAULT_GATEWAY_HTTP_TOOL_DENY,
  GATEWAY_OWNER_ONLY_CORE_TOOLS,
  HOST_FS_BUILTIN_CODING_DENY_NAMES,
} from "../security/dangerous-tools.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";

type GatewayScopedToolSurface = "http" | "loopback";

/** Resolve the tools visible to a gateway caller after agent, channel, and surface policy. */
export function resolveGatewayScopedTools(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  runtimePolicySessionKey?: string;
  agentId?: string;
  sessionId?: string;
  modelProvider?: string;
  modelId?: string;
  onYield?: (message: string) => Promise<void> | void;
  messageProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentInboundAudio?: boolean;
  clientCaps?: string[];
  accountId?: string;
  inboundEventKind?: InboundEventKind;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  requireExplicitMessageTarget?: boolean;
  agentTo?: string;
  agentThreadId?: string;
  senderIsOwner?: boolean;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  allowGatewaySubagentBinding?: boolean;
  allowMediaInvokeCommands?: boolean;
  surface?: GatewayScopedToolSurface;
  excludeToolNames?: Iterable<string>;
  disablePluginTools?: boolean;
  gatewayRequestedTools?: string[];
  /** Add the CLI-only, node-forced exec tool before applying the shared policy pipeline. */
  includeNodeExecTool?: boolean;
  execSession?: ExecSessionDefaults;
  execOverrides?: ExecPolicyOverrides;
  bashElevated?: ExecElevatedDefaults;
  trigger?: string;
  approvalReviewerDeviceId?: string;
  channelContext?: PluginHookChannelContext;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  spawnedBy?: string;
}) {
  const runtimePolicySessionKey = params.runtimePolicySessionKey?.trim() || params.sessionKey;
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
  } = resolveEffectiveToolPolicy({
    config: params.cfg,
    sessionKey: runtimePolicySessionKey,
    agentId: params.agentId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const surface = params.surface ?? "http";
  const nodeExecSurface = surface === "loopback" && params.includeNodeExecTool === true;
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
  const senderId = params.channelContext?.sender?.id;
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: runtimePolicySessionKey,
    spawnedBy: params.spawnedBy,
    messageProvider: params.messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.accountId ?? null,
    senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  // Only immutable Gateway-launched grants can opt into node exec. Match the
  // embedded runner's wildcard sender policy while preserving owner WebChat.
  const isOwnerInternalSession =
    nodeExecSurface &&
    params.senderIsOwner === true &&
    normalizeMessageChannel(params.messageProvider) === INTERNAL_MESSAGE_CHANNEL;
  const shouldResolveSenderPolicy = nodeExecSurface ? !isOwnerInternalSession : Boolean(senderId);
  const senderPolicy = shouldResolveSenderPolicy
    ? resolveSenderToolPolicy({
        config: params.cfg,
        agentId,
        messageProvider: params.messageProvider,
        senderId,
        senderName: params.senderName,
        senderUsername: params.senderUsername,
        senderE164: params.senderE164,
      })
    : undefined;
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: runtimePolicySessionKey,
    agentId,
  });
  const sandboxPolicy = sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined;
  const subagentStore = resolveSubagentCapabilityStore(runtimePolicySessionKey, {
    cfg: params.cfg,
  });
  const subagentPolicy = isSubagentEnvelopeSession(runtimePolicySessionKey, {
    cfg: params.cfg,
    store: subagentStore,
  })
    ? resolveSubagentToolPolicyForSession(params.cfg, runtimePolicySessionKey, {
        store: subagentStore,
      })
    : undefined;
  const inheritedToolPolicy = resolveInheritedToolPolicyForSession(
    params.cfg,
    runtimePolicySessionKey,
    { store: subagentStore },
  );
  const excludedToolNames = params.excludeToolNames ? Array.from(params.excludeToolNames) : [];
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
    senderPolicy,
    sandboxPolicy,
    subagentPolicy,
    inheritedToolPolicy,
    defaultGatewayDeny.length > 0 ? { deny: defaultGatewayDeny } : undefined,
    ownerOnlyGatewayDeny.length > 0 ? { deny: ownerOnlyGatewayDeny } : undefined,
    Array.isArray(gatewayToolsCfg?.deny) ? { deny: gatewayToolsCfg.deny } : undefined,
  ]);
  const inheritedToolDenylist = [...explicitDenylist];
  const hostFsBuiltinCodingDeny = new Set<string>(HOST_FS_BUILTIN_CODING_DENY_NAMES);
  // The host-FS `read` name gates the BUILT-IN coding tool at the final gateway deny
  // filter, which preserves a same-named PLUGIN tool. It must NOT be passed to the
  // plugin loader's denylist, or the production plugin resolver drops a same-named
  // plugin tool by name before it can reach that filter (clawsweeper #85664 [P2]).
  // `read` denied for any OTHER reason (explicit `gateway.tools.deny`, owner-only,
  // or excluded) stays in the plugin denylist.
  const gatewayConfiguredDeny = Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : [];
  const pluginToolDenylist = explicitDenylist.filter((name) => {
    if (!hostFsBuiltinCodingDeny.has(name)) {
      return true;
    }
    const deniedOnlyByHostFsDefault =
      (defaultGatewayDeny as readonly string[]).includes(name) &&
      !(ownerOnlyGatewayDeny as readonly string[]).includes(name) &&
      !gatewayConfiguredDeny.includes(name) &&
      !excludedToolNames.includes(name);
    return !deniedOnlyByHostFsDefault;
  });
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
    senderPolicy,
    sandboxPolicy,
    subagentPolicy,
    inheritedToolPolicy,
    gatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : undefined,
  ].some(hasRestrictiveAllowPolicy);
  const shouldCaptureCronCreatorToolAllowlist =
    shouldInheritEffectiveToolAllowlist ||
    explicitDenylist.length > 0 ||
    excludedToolNames.length > 0;

  const openClawTools = createOpenClawTools({
    agentSessionKey: params.sessionKey,
    requesterAgentIdOverride: agentId,
    agentChannel: params.messageProvider ?? undefined,
    agentAccountId: params.accountId,
    inboundEventKind: params.inboundEventKind,
    sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
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
    conversationReadOrigin: params.conversationReadOrigin,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    allowMediaInvokeCommands: params.allowMediaInvokeCommands,
    disablePluginTools: params.disablePluginTools,
    wrapBeforeToolCallHook: false,
    config: params.cfg,
    clientCaps: params.clientCaps,
    workspaceDir,
    sandboxed: sandboxRuntime.sandboxed,
    pluginToolAllowlist: collectExplicitAllowlist([
      profilePolicy,
      providerProfilePolicy,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      senderPolicy,
      sandboxPolicy,
      subagentPolicy,
      inheritedToolPolicy,
      gatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : undefined,
    ]),
    pluginToolDenylist,
    cronCreatorToolAllowlist: shouldCaptureCronCreatorToolAllowlist
      ? cronCreatorToolAllowlist
      : undefined,
    inheritedToolAllowlist,
    inheritedToolDenylist,
  });
  const nodeExecCandidate = nodeExecSurface
    ? resolveExecDefaults({
        cfg: params.cfg,
        sessionEntry: params.execSession,
        execOverrides: params.execOverrides,
        agentId,
        sessionKey: runtimePolicySessionKey,
        sandboxAvailable: sandboxRuntime.sandboxed,
      })
    : undefined;
  const includeNodeExecTool = nodeExecCandidate?.canRequestNode === true;
  const execConfig = includeNodeExecTool
    ? resolveExecToolConfig({ cfg: params.cfg, agentId })
    : undefined;
  // CLI backends already own their local shell. This extra surface is deliberately
  // fixed to node so it cannot become a second path to Gateway-local execution.
  const baseTools = nodeExecSurface
    ? openClawTools.filter((tool) => tool.name.trim().toLowerCase() !== "exec")
    : openClawTools;
  const allTools = includeNodeExecTool
    ? [
        ...baseTools,
        createLazyExecTool(
          {
            host: "node",
            mode: nodeExecCandidate.mode,
            security: nodeExecCandidate.security,
            ask: nodeExecCandidate.ask,
            trigger: params.trigger,
            node: nodeExecCandidate.node,
            pathPrepend: execConfig?.pathPrepend,
            safeBins: execConfig?.safeBins,
            strictInlineEval: execConfig?.strictInlineEval,
            commandHighlighting: execConfig?.commandHighlighting,
            safeBinTrustedDirs: execConfig?.safeBinTrustedDirs,
            safeBinProfiles: execConfig?.safeBinProfiles,
            reviewer: execConfig?.reviewer,
            config: params.cfg,
            agentId,
            elevated: params.bashElevated,
            cwd: workspaceDir,
            allowBackground: false,
            scopeKey: params.sessionKey,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            sessionStore: params.cfg.session?.store,
            mainKey: params.cfg.session?.mainKey,
            sessionScope: params.cfg.session?.scope,
            eventRouting: resolveEventSessionRoutingPolicy({
              cfg: params.cfg,
              sessionKey: params.sessionKey,
              channel: params.messageProvider,
              accountId: params.accountId,
            }),
            messageProvider: params.messageProvider,
            currentChannelId: params.currentChannelId ?? params.agentTo,
            currentThreadTs: params.currentThreadTs ?? params.agentThreadId,
            channelContext: params.channelContext,
            accountId: params.accountId,
            approvalReviewerDeviceId: params.approvalReviewerDeviceId,
            backgroundMs: execConfig?.backgroundMs,
            timeoutSec: execConfig?.timeoutSec,
            approvalRunningNoticeMs: execConfig?.approvalRunningNoticeMs,
            notifyOnExit: execConfig?.notifyOnExit,
            notifyOnExitEmptySuccess: execConfig?.notifyOnExitEmptySuccess,
          },
          {
            description:
              "Execute a shell command on a connected OpenClaw node. This tool is node-only; use the CLI native shell for Gateway-local commands. Commands run synchronously. Set node when multiple nodes are available.",
            displaySummary: "Run commands on a connected node",
            parameters: nodeExecSchema,
          },
        ),
      ]
    : baseTools;

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

  const toolsForMessageProvider = filterToolsByMessageProvider(
    allToolsWithCoding,
    params.messageProvider,
  );
  const policyFiltered = applyToolPolicyPipeline({
    tools: toolsForMessageProvider,
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
        senderPolicy,
        agentId,
      }),
      { policy: sandboxPolicy, label: "sandbox tools.allow" },
      { policy: subagentPolicy, label: "subagent tools.allow" },
      { policy: inheritedToolPolicy, label: "inherited tools" },
    ],
    declaredToolAllowlist: buildDeclaredToolAllowlistContext({
      config: params.cfg,
      workspaceDir,
      toolDenylist: explicitDenylist,
    }),
  });

  const explicitGatewayDeny = Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : [];
  const gatewayDenySet = new Set([
    ...defaultGatewayDeny,
    ...ownerOnlyGatewayDeny,
    ...explicitGatewayDeny,
    ...excludedToolNames,
  ]);
  const tools = policyFiltered.filter((tool) => {
    if (!gatewayDenySet.has(tool.name)) {
      return true;
    }
    // Preserve a same-named PLUGIN tool when the ONLY reason it is denied is the
    // host-FS built-in `read` default-deny. That default exists to gate the
    // BUILT-IN coding tool (which has no plugin meta) behind the directInvoke
    // opt-in — not to break a plugin tool the operator allowlisted. The built-in
    // stays denied; any OTHER deny reason (owner-only, explicit
    // `gateway.tools.deny`, excluded, or inherently dangerous names like
    // `exec`/`fs_write`) still drops the tool.
    const deniedOnlyByHostFsBuiltinDefault =
      hostFsBuiltinCodingDeny.has(tool.name) &&
      (defaultGatewayDeny as readonly string[]).includes(tool.name) &&
      !(ownerOnlyGatewayDeny as readonly string[]).includes(tool.name) &&
      !explicitGatewayDeny.includes(tool.name) &&
      !excludedToolNames.includes(tool.name);
    return deniedOnlyByHostFsBuiltinDefault && getPluginToolMeta(tool) !== undefined;
  });
  // The loopback exec tool is node-only. Do not let a raw `exec` capability get
  // reinterpreted as generic Gateway/sandbox exec by spawned sessions or cron jobs.
  const inheritableTools = includeNodeExecTool
    ? tools.filter((tool) => tool.name.trim().toLowerCase() !== "exec")
    : tools;
  if (shouldInheritEffectiveToolAllowlist) {
    replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, inheritableTools);
  }
  if (shouldCaptureCronCreatorToolAllowlist) {
    replaceWithEffectiveCronCreatorToolAllowlist(
      cronCreatorToolAllowlist,
      inheritableTools,
      (tool) => getPluginToolMeta(tool),
    );
  }

  return {
    agentId,
    tools,
    workspaceDir,
  };
}
