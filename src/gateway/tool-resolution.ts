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
    pluginToolDenylist: explicitDenylist,
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

  // Wire the `read`/`write`/`edit` coding tools into the gateway direct-invoke
  // surfaces so they are reachable for deterministic automation (CI/preflight
  // checks, lint, browser capture flows) without a full LLM round-trip. Part of
  // the broader direct-invoke umbrella tracked in #37131; `read` is the narrow
  // landing on PR #85664, `write`/`edit` the write-class extension on #63919.
  //
  // **Triple-key gating** (addresses ClawSweeper [P1] + the non-owner
  // authorization finding on PR #85664/#63919). For each tool ALL THREE hold:
  // - `surface === "http"` — the **direct-invoke marker** set by
  //   `tools-invoke-shared.ts` for BOTH HTTP `POST /tools/invoke` AND SDK-facing
  //   JSON-RPC `tools.invoke` (they share the resolver). MCP loopback uses
  //   `surface === "loopback"` and is unaffected.
  // - the per-class opt-in — `gateway.tools.directInvoke.hostFsRead: true` for
  //   `read`, `gateway.tools.directInvoke.hostFsWrite: true` for `write`/`edit`.
  //   Without it the tool is NOT materialized into the candidate set, so
  //   existing configs that have `gateway.tools.allow: ["read"]` (or `write`)
  //   for unrelated reasons stay inert. This prevents an upgrade-time
  //   compatibility break.
  // - `params.senderIsOwner === true` — the **owner gate**. Host-filesystem
  //   read/write is an owner/admin-only capability, so it must NOT be
  //   materialized for a non-owner direct-invoke caller. On the HTTP/RPC surface
  //   a shared-secret bearer caller resolves to owner (`senderIsOwner === true`),
  //   while a trusted-proxy operator without `ADMIN_SCOPE` resolves to `false`.
  //   This mirrors the fail-closed owner semantics used for `ownerOnlyGatewayDeny`
  //   above (line 130): on HTTP, anything other than an explicit `true` is
  //   treated as non-owner. Without this key a `gateway.auth.mode="trusted-proxy"`
  //   `operator.write` caller could read/write host files it should never reach.
  // - `gateway.tools.allow: ["read"]` (or `["write","edit"]`) — separately
  //   required, lifts the name(s) from `DEFAULT_GATEWAY_HTTP_TOOL_DENY` so the
  //   policy pipeline (line 186) doesn't filter them out. This key keeps the
  //   explicit operator acceptance step visible in the standard policy surface.
  //
  // `read` is materialized behind `directInvoke.hostFsRead`; `write`/`edit`
  // behind `directInvoke.hostFsWrite` (PR #63919). Each class opt-in is
  // independent, and BOTH are owner-gated and `surface === "http"`-gated.
  // `exec`/`process`/`spawn`/`shell` (RCE-class) are intentionally NOT
  // materialized here — they need a separate owner/admin model and are
  // deferred to a follow-up PR. `apply_patch` is in the HTTP deny list for
  // future-proofing but is not produced by the factory yet, so `hostFsWrite`
  // has no effect on it.
  //
  // Uses `createOpenClawCodingToolsRaw` (unwrapped) — `handleToolsInvokeHttp`
  // already calls `runBeforeToolCallHook` itself before dispatch, so the
  // tools must arrive unwrapped to avoid double-firing the hook and leaking
  // adjusted-params state.
  //
  // Construction plan limits the factory to just the base coding tool family
  // (read/write/edit/apply_patch) — no shell (exec/process), no channel,
  // OpenClaw, or plugin tools. Then we filter to the opted-in names.
  const allowHostFsReadOverDirectInvoke =
    surface === "http" &&
    params.cfg.gateway?.tools?.directInvoke?.hostFsRead === true &&
    params.senderIsOwner === true;
  // Host-filesystem WRITE is materially more dangerous than read, so it carries
  // the same owner gate (a trusted-proxy `operator.write` caller is refused
  // even with `hostFsWrite: true` + `tools.allow` set) plus its own opt-in.
  const allowHostFsWriteOverDirectInvoke =
    surface === "http" &&
    params.cfg.gateway?.tools?.directInvoke?.hostFsWrite === true &&
    params.senderIsOwner === true;
  const directInvokeCodingToolNames = new Set<string>();
  if (allowHostFsReadOverDirectInvoke) {
    directInvokeCodingToolNames.add("read");
  }
  if (allowHostFsWriteOverDirectInvoke) {
    // `write` + `edit` are produced by the base coding tool factory.
    // `apply_patch` is currently a host-tool name that lives only in
    // DEFAULT_GATEWAY_HTTP_TOOL_DENY (no factory entry yet) so adding it here
    // would be a no-op for now; deferred until upstream adds the factory entry.
    directInvokeCodingToolNames.add("write");
    directInvokeCodingToolNames.add("edit");
  }
  const codingTools =
    directInvokeCodingToolNames.size > 0
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
        }).filter((tool) => directInvokeCodingToolNames.has(tool.name))
      : [];

  // Coding built-ins take precedence on name collision when a class opt-in is
  // active, ensuring `read`/`write`/`edit` resolves to the built-in filesystem
  // tool documented by the opt-in/audit surface rather than a same-named plugin.
  // When no class opt-in is active, `codingTools` is empty so `allTools` is
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
  const hostFsBuiltinCodingDeny = new Set<string>(HOST_FS_BUILTIN_CODING_DENY_NAMES);
  const tools = policyFiltered.filter((tool) => {
    if (!gatewayDenySet.has(tool.name)) {
      return true;
    }
    // Preserve a same-named PLUGIN tool when the ONLY reason it is denied is the
    // host-FS built-in coding default-deny (`read`/`write`/`edit`). That default
    // exists to gate the BUILT-IN coding tool (which has no plugin meta) behind
    // the directInvoke opt-in — not to break a plugin tool the operator
    // allowlisted. The built-in stays denied; any OTHER deny reason
    // (owner-only, explicit `gateway.tools.deny`, excluded, or the inherently
    // dangerous names like `exec`/`fs_write`) still drops the tool.
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
