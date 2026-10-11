// Gateway-scoped tool resolution for HTTP and loopback tool surfaces.
import {
  getAdmittedRunDelegatedAuthority,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentIds } from "../agents/agent-scope.js";
import { applyToolAvailabilityDescriptions } from "../agents/agent-tools.deferred-followup.js";
import { createOpenClawCodingToolsInternalAsync } from "../agents/agent-tools.js";
import { filterToolsByMessageProvider } from "../agents/agent-tools.message-provider-policy.js";
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { nodeExecSchema } from "../agents/bash-tools.schemas.js";
import { resolveCoreToolFactoryFamily } from "../agents/core-tool-factory-descriptors.js";
import { applyDelegationCapability } from "../agents/delegation-capability.js";
import { resolveExecDefaults } from "../agents/exec-defaults.js";
import { createLazyExecTool, resolveExecToolConfig } from "../agents/lazy-exec-tool.js";
import { createOpenClawToolsAsync } from "../agents/openclaw-tools.js";
import { filterRequesterYieldTools } from "../agents/openclaw-tools.requester-yield.js";
import {
  applySwarmCollectorToolContract,
  createSwarmCollectorWriteAuthority,
  resolveSwarmCollectorToolContext,
} from "../agents/openclaw-tools.swarm.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { createScheduledMessageInvocationAdmission } from "../agents/scheduled-message-invocation.js";
import { resolveScheduledToolCallerContext } from "../agents/scheduled-tool-policy.js";
import { buildDeclaredToolAllowlistContext } from "../agents/tool-policy-declared-context.js";
import { filterToolsByPolicy } from "../agents/tool-policy-match.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../agents/tool-policy-pipeline.js";
import {
  collectExplicitAllowlist,
  collectExplicitDenylist,
  hasRestrictiveAllowPolicy,
  mergeAlsoAllowPolicy,
  normalizeToolPolicyName,
  replaceWithEffectiveToolAllowlist,
  resolveToolProfilePolicy,
} from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  captureFinalEffectiveCronCreatorToolAllowlist,
  replaceWithEffectiveCronCreatorToolAllowlist,
  type CronCreatorToolAllowlistEntry,
  type CronToolsAllowCaptureRef,
} from "../agents/tools/cron-tool.js";
import { createChannelQuestionPromptDelivery } from "../agents/tools/question-prompt-send.js";
import { prepareSessionPortalToolTarget } from "../agents/tools/session-portal-target.js";
import {
  hasSessionControlAuthority,
  prepareSandboxSessionRename,
} from "../agents/tools/sessions-operator-authority.js";
import type { SkillWorkshopRunOptions } from "../agents/tools/skill-workshop-tool-factory.js";
import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import type { SessionEventSourcePolicy } from "../auto-reply/reply/session-event-contract.js";
import type { ConversationReadInvocationOrigin } from "../channels/plugins/conversation-read-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import { resolveExactExecModeFromPolicy } from "../infra/exec-approvals.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  DEFAULT_GATEWAY_HTTP_TOOL_DENY,
  GATEWAY_OWNER_ONLY_CORE_TOOLS,
} from "../security/dangerous-tools.js";
import type { McpLoopbackRequestContext } from "./mcp-grant-store.js";
import {
  captureGatewayToolResolutionAuthority,
  resolveGatewayRequesterToolPolicies,
} from "./tool-resolution-authority.js";

type GatewayScopedToolSurface = "http" | "loopback";

/** Resolve the tools visible to a gateway caller after agent, channel, and surface policy. */
export async function resolveGatewayScopedTools(
  params: Omit<
    McpLoopbackRequestContext,
    | "senderIsOwner"
    | "currentMessageId"
    | "nativeCronCreatorToolAllowlist"
    | "toolsAllow"
    | "nodeExecAllowed"
    | "cronCreatorCallerOrigin"
  > & {
    cfg: OpenClawConfig;
    /** Workspace from the invocation owner's exact session read. */
    preparedSessionWorkspaceDir?: string;
    messageActionTurnCapability?: string;
    authProfileStore?: AuthProfileStore;
    agentDir?: string;
    onYield?: (message: string, acknowledgment?: string) => Promise<void> | void;
    currentMessageId?: string | number;
    agentTo?: string;
    agentThreadId?: string;
    senderIsOwner?: boolean;
    admittedRunContext?: AdmittedRunContext;
    sessionEventSourcePolicy?: SessionEventSourcePolicy;
    conversationReadOrigin?: ConversationReadInvocationOrigin;
    allowGatewaySubagentBinding?: boolean;
    allowMediaInvokeCommands?: boolean;
    surface?: GatewayScopedToolSurface;
    /**
     * Liveness of the client grant this request authenticated with, supplied by
     * the loopback server. Run-contract tools re-check it before they write.
     */
    isGrantCurrent?: () => boolean;
    /** Authenticated standalone invocation lifetime supplied by its HTTP/RPC owner. */
    assertInvocationCurrent?: () => void;
    /** SQL-safe input policy, separate from invocation authority that may read state. */
    assertInputCommitAllowed?: () => void;
    excludeToolNames?: Iterable<string>;
    /** Server-minted coding tools that must be mediated through the loopback surface. */
    mediatedToolNames?: Iterable<string>;
    /** Host-projected canonical authority for native CLI tools absent from this bridge. */
    nativeCronCreatorToolAllowlist?: readonly string[];
    disablePluginTools?: boolean;
    gatewayRequestedTools?: string[];
    /** Add the CLI-only, node-forced exec tool before applying the shared policy pipeline. */
    includeNodeExecTool?: boolean;
    /** Current node inventory predicate; evaluated with the resolved exec binding. */
    nodeExecAvailable?: (node?: string) => boolean;
    pairedNodeComputerUse?: import("../agents/computer-use-node-capabilities.js").PreparedPairedComputerUse;
    skillWorkshop?: SkillWorkshopRunOptions;
  },
  assertPreparationCurrent?: () => void,
) {
  const { assertCurrent, assertInvocationCurrent } = captureGatewayToolResolutionAuthority(
    params,
    assertPreparationCurrent,
  );
  assertCurrent();
  const runtimePolicySessionKey = params.runtimePolicySessionKey?.trim() || params.sessionKey;
  const sessionAgentId = resolveSessionAgentIds({
    config: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  }).sessionAgentId;
  const hasSeparateRuntimePolicyIdentity = Boolean(
    params.runtimePolicySessionKey?.trim() || params.runtimePolicyAgentId?.trim(),
  );
  const runtimePolicyAgentId = hasSeparateRuntimePolicyIdentity
    ? resolveSessionAgentIds({
        config: params.cfg,
        sessionKey: runtimePolicySessionKey,
        agentId: params.runtimePolicyAgentId,
      }).sessionAgentId
    : sessionAgentId;
  const surface = params.surface ?? "http";
  const nodeExecSurface = surface === "loopback" && params.includeNodeExecTool === true;
  const gatewayRequestedTools = params.gatewayRequestedTools ?? [];
  const messageProvider = params.messageProvider?.trim().toLowerCase();
  const gatewayCaller = resolveScheduledToolCallerContext({
    scheduledToolPolicy: params.scheduledToolPolicy,
    accountId: params.accountId,
    channel: messageProvider,
  });
  const sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined =
    params.sourceReplyDeliveryMode ??
    (params.inboundEventKind === "room_event" && messageProvider !== "webchat"
      ? "message_tool_only"
      : undefined);
  const runtimeAlsoAllow = sourceReplyDeliveryMode === "message_tool_only" ? ["message"] : [];
  function resolveConfiguredToolPolicies(config: OpenClawConfig) {
    const effective = resolveEffectiveToolPolicy({
      config,
      sessionKey: runtimePolicySessionKey,
      agentId: runtimePolicyAgentId,
      modelProvider: params.modelProvider,
      modelId: params.modelId,
    });
    const profilePolicy = resolveToolProfilePolicy(effective.profile);
    const providerProfilePolicy = resolveToolProfilePolicy(effective.providerProfile);
    return {
      ...effective,
      profilePolicy,
      providerProfilePolicy,
      profilePolicyWithAlsoAllow: mergeAlsoAllowPolicy(profilePolicy, [
        ...(effective.profileAlsoAllow ?? []),
        ...gatewayRequestedTools,
        ...runtimeAlsoAllow,
      ]),
      providerProfilePolicyWithAlsoAllow: mergeAlsoAllowPolicy(providerProfilePolicy, [
        ...(effective.providerProfileAlsoAllow ?? []),
        ...gatewayRequestedTools,
        ...runtimeAlsoAllow,
      ]),
    };
  }
  const configuredToolPolicies = resolveConfiguredToolPolicies(params.cfg);
  const {
    agentId: resolvedPolicyAgentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profilePolicy,
    providerProfilePolicy,
    gatewayConfigReadAllowed,
  } = configuredToolPolicies;
  const policyAgentId = resolvedPolicyAgentId ?? runtimePolicyAgentId;
  const senderId = params.channelContext?.sender?.id;
  const requesterPolicies = resolveGatewayRequesterToolPolicies(params, {
    runtimePolicySessionKey,
    policyAgentId,
    nodeExecSurface,
    accountId: gatewayCaller.accountId,
  });
  const { groupPolicy, senderPolicy, subagentPolicy, inheritedToolPolicy } = requesterPolicies;
  const sessionPermissionPolicy =
    requesterPolicies.inheritedToolPolicySource === "sender"
      ? params.sessionPermissionPolicy
      : undefined;
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: sessionAgentId,
    classificationSessionKey: runtimePolicySessionKey,
    classificationAgentId: policyAgentId,
  });
  const sandboxed = sandboxRuntime.sandboxed;
  const preparedSandboxPolicy = sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined;
  const sessionControlAuthority = readAdmittedRunOperatorAuthority(params.admittedRunContext);
  const { policy: sandboxPolicy, renameOnly: sandboxSessionRenameOnly } =
    prepareSandboxSessionRename({
      policy: preparedSandboxPolicy,
      senderIsOwner:
        surface === "loopback" && params.admittedRunContext ? params.senderIsOwner : undefined,
      authority: sessionControlAuthority,
    });
  const excludedToolNames = params.excludeToolNames ? Array.from(params.excludeToolNames) : [];
  const mediatedToolNames = new Set(
    Array.from(params.mediatedToolNames ?? [], (name) => normalizeToolPolicyName(name)).filter(
      Boolean,
    ),
  );
  const gatewayToolsCfg = params.cfg.gateway?.tools;
  const sessionPortalTarget =
    surface === "loopback" && params.senderIsOwner === false && !sandboxed
      ? prepareSessionPortalToolTarget({
          sessionKey: params.sessionKey,
          agentId: sessionAgentId,
          sessionId: params.sessionId,
        })
      : undefined;
  const defaultGatewayDeny =
    surface === "http"
      ? DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter(
          // Config allow entries may use legacy tool names (e.g. "cron");
          // normalize both sides so they still lift the matching default deny.
          (name) =>
            !gatewayToolsCfg?.allow?.some(
              (allowed) => normalizeToolPolicyName(allowed) === normalizeToolPolicyName(name),
            ),
        )
      : [];
  const assignmentAdmitted =
    surface === "loopback" &&
    params.admittedRunContext &&
    getAdmittedRunDelegatedAuthority(params.admittedRunContext);
  const ownerOnlyGatewayDeny = [
    ...(params.senderIsOwner === false || (surface === "http" && params.senderIsOwner !== true)
      ? GATEWAY_OWNER_ONLY_CORE_TOOLS.filter(
          (name) => name !== "sessions" && (name !== "portal" || !sessionPortalTarget),
        )
      : []),
    // Attach grants also use loopback; session binding is not run authority.
    ...(params.senderIsOwner !== true &&
    !assignmentAdmitted &&
    !(surface === "loopback" && hasSessionControlAuthority(sessionControlAuthority))
      ? ["sessions"]
      : []),
  ];
  // HTTP callers start with additional surface denies because they cross auth only.
  const workspaceDir =
    (requesterPolicies.inheritedToolPolicySource === "sender"
      ? params.preparedSessionWorkspaceDir?.trim()
      : undefined) ||
    params.workspaceDir?.trim() ||
    resolveAgentWorkspaceDir(params.cfg, sessionAgentId);
  const basePolicies = [
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
  ];
  const requestedPolicies = [
    ...basePolicies,
    gatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : undefined,
  ];
  const explicitDenylist = collectExplicitDenylist([
    ...basePolicies,
    defaultGatewayDeny.length > 0 ? { deny: defaultGatewayDeny } : undefined,
    ownerOnlyGatewayDeny.length > 0 ? { deny: ownerOnlyGatewayDeny } : undefined,
    Array.isArray(gatewayToolsCfg?.deny) ? { deny: gatewayToolsCfg.deny } : undefined,
  ]);
  const inheritedToolDenylist = [
    ...explicitDenylist,
    ...(requesterPolicies.inheritedToolPolicyForSpawn?.deny ?? []),
  ];
  // Passed by reference to sessions_spawn and populated after the final policy
  // pass so child sessions inherit the actual parent tool surface.
  const inheritedToolAllowlist: string[] = [];
  const cronCreatorToolAllowlist: CronCreatorToolAllowlistEntry[] = [];
  const cronCreatorToolAllowlistCaptureRef: CronToolsAllowCaptureRef | undefined =
    surface === "loopback" ? {} : undefined;
  const shouldInheritEffectiveToolAllowlist = requestedPolicies.some(hasRestrictiveAllowPolicy);

  // CLI backends reach OpenClaw tools through this resolver instead of the
  // embedded runner, and the loopback grant carries no collector fields, so the
  // subagent registry supplies the collector run contract for this child.
  //
  // Authority is the admitted collector run, not the transport. `params.runId`
  // reaches this resolver only from `McpLoopbackRequestContext.runId`, which
  // `resolveMcpRequestContext` copies out of a Gateway-minted, run-bound CLI
  // client grant; the session-scoped `openclaw attach` branch and the
  // header-derived branch never set it, and the `http` caller never passes one.
  // Requiring that id to match the registry's collector record therefore admits
  // the collector child's own run and nobody else, including an attach client
  // bound to that same collector session.
  const swarmCollectorAdmission = {
    childSessionKey: params.sessionKey,
    childAgentId: sessionAgentId,
    admittedRunId: surface === "loopback" ? params.runId : undefined,
  };
  const swarmCollectorContext = resolveSwarmCollectorToolContext(swarmCollectorAdmission);
  const commonToolOptions = () => ({
    runId: params.runId,
    inboundEventKind: params.inboundEventKind,
    sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    currentMessageId: params.currentMessageId,
    currentInboundAudio: params.currentInboundAudio,
    sessionId: params.sessionId,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    senderIsOwner: params.senderIsOwner,
    config: params.cfg,
    sessionConfigSource: "runtime" as const,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    modelHasVision: params.modelHasVision,
    requesterModel: params.requesterModel,
    pairedNodeComputerUse: params.pairedNodeComputerUse,
    clientCaps: params.clientCaps,
    gatewayUiCommandTarget: params.gatewayUiCommandTarget,
    workspaceDir,
    sessionPermissionPolicy,
    // Transport dispatchers own hooks for both tool factories.
    wrapBeforeToolCallHook: false,
    agentAccountId: params.accountId,
  });
  const openClawToolOptions: Parameters<typeof createOpenClawToolsAsync>[0] = {
    ...commonToolOptions(),
    sessionPortalTarget,
    gatewayConfigReadAllowed,
    agentSessionKey: params.sessionKey,
    messageToolTurnCapability:
      surface === "loopback" && params.messageActionTurnCapability
        ? { token: params.messageActionTurnCapability, sessionKey: runtimePolicySessionKey }
        : undefined,
    admitScheduledMessageInvocation: params.messageActionTurnCapability
      ? createScheduledMessageInvocationAdmission({
          config: params.cfg,
          isAllowed: (config): boolean =>
            tools.some((tool) => tool.name === "message") &&
            filterGatewayToolPolicies(config).some((tool) => tool.name === "message"),
        })
      : undefined,
    assertInputCommitAllowed: params.assertInputCommitAllowed,
    assertInvocationCurrent,
    ...(swarmCollectorContext
      ? {
          swarmCollector: true,
          assertCollectorWriteAuthority: createSwarmCollectorWriteAuthority({
            admission: swarmCollectorAdmission,
            isGrantCurrent: params.isGrantCurrent,
          }),
          ...(swarmCollectorContext.swarmOutputSchema
            ? { swarmOutputSchema: swarmCollectorContext.swarmOutputSchema }
            : {}),
        }
      : {}),
    execSession: params.execSession,
    execOverrides: params.execOverrides,
    approvalReviewerDeviceIds: params.approvalReviewerDeviceId
      ? [params.approvalReviewerDeviceId]
      : undefined,
    requesterAgentIdOverride: sessionAgentId,
    agentChannel: params.messageProvider ?? undefined,
    questionPrompt: createChannelQuestionPromptDelivery({
      cfg: params.cfg,
      channel: params.messageProvider,
      to: params.currentChannelId ?? params.agentTo,
      accountId: params.accountId,
      threadId: params.currentThreadTs ?? params.agentThreadId,
    }),
    gatewayCallerAccountId: gatewayCaller.accountId,
    gatewayCallerChannel: gatewayCaller.channel,
    gatewayCallerLocal: gatewayCaller.local,
    sourceReplyOnly: params.sourceReplyOnly,
    agentTo: params.agentTo,
    agentThreadId: params.agentThreadId,
    currentChannelId: params.currentChannelId ?? params.agentTo,
    currentThreadTs: params.currentThreadTs ?? params.agentThreadId,
    replyToMode: params.replyToMode,
    onYield: params.onYield,
    requesterSenderId: senderId,
    sessionControlAuthority,
    sandboxSessionRenameOnly,
    conversationReadOrigin: params.conversationReadOrigin,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    skillWorkshop: params.skillWorkshop,
    allowMediaInvokeCommands: params.allowMediaInvokeCommands,
    disablePluginTools: params.disablePluginTools,
    agentDir: params.agentDir,
    authProfileStore: params.authProfileStore,
    pinnedWidgetAuthoring: surface === "loopback" ? params.pinnedWidgetAuthoring : undefined,
    sandboxed,
    pluginToolAllowlist: collectExplicitAllowlist(requestedPolicies),
    pluginToolDenylist: explicitDenylist,
    cronCreatorToolAllowlist,
    cronCreatorToolAllowlistCaptureRef,
    inheritedToolAllowlist,
    inheritedToolDenylist,
    inheritedToolPolicySource: requesterPolicies.inheritedToolPolicySource,
    delegatedToolPolicyUnavailable: Boolean(requesterPolicies.delegatedToolPolicy),
  };
  const openClawTools = await createOpenClawToolsAsync(openClawToolOptions, { assertCurrent });
  assertCurrent();
  const execDefaults =
    nodeExecSurface || mediatedToolNames.size > 0
      ? resolveExecDefaults({
          cfg: params.cfg,
          sessionEntry: params.execSession,
          execOverrides: params.execOverrides,
          agentId: policyAgentId,
          sessionKey: runtimePolicySessionKey,
          sandboxAvailable: sandboxed,
        })
      : undefined;
  const nodeExecDefaults =
    nodeExecSurface &&
    execDefaults?.canRequestNode === true &&
    params.nodeExecAvailable?.(execDefaults.node) === true
      ? execDefaults
      : undefined;
  const includeNodeExecTool = nodeExecDefaults !== undefined;
  const execConfig = includeNodeExecTool
    ? resolveExecToolConfig({ cfg: params.cfg, agentId: policyAgentId })
    : undefined;
  const mediatedToolFamilies = new Set(Array.from(mediatedToolNames, resolveCoreToolFactoryFamily));
  const includeMediatedBaseCodingTools = mediatedToolFamilies.has("base-coding");
  const includeMediatedShellTools = mediatedToolFamilies.has("shell");
  const mediatedCodingTools =
    surface === "loopback" && (includeMediatedBaseCodingTools || includeMediatedShellTools)
      ? await createOpenClawCodingToolsInternalAsync({
          ...commonToolOptions(),
          sessionEventSourcePolicy: params.sessionEventSourcePolicy,
          agentId: policyAgentId,
          sessionKey: runtimePolicySessionKey,
          runSessionKey: params.sessionKey,
          operationalRunInstance: params.admittedRunContext?.operationalRunInstance,
          cwd: params.cwd?.trim() || workspaceDir,
          messageProvider: params.messageProvider,
          messageChannel: params.messageProvider,
          currentChannelId: params.currentChannelId,
          currentThreadTs: params.currentThreadTs,
          channelContext: params.channelContext,
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          spawnedBy: params.spawnedBy,
          senderId: params.channelContext?.sender?.id,
          senderName: params.senderName,
          senderUsername: params.senderUsername,
          senderE164: params.senderE164,
          conversationToolPolicy: params.conversationToolPolicy,
          inputProvenance: params.inputProvenance,
          trustedInternalHandoff: params.trustedInternalHandoff,
          trigger: params.trigger,
          continuesConversation: params.continuesConversation,
          approvalReviewerDeviceId: params.approvalReviewerDeviceId,
          runtimeToolAllowlist: [...mediatedToolNames],
          exec: execDefaults
            ? {
                host: execDefaults.host,
                // A display mode must not replace an unrepresentable exact policy.
                mode:
                  resolveExactExecModeFromPolicy(execDefaults) === null
                    ? undefined
                    : execDefaults.mode,
                security: execDefaults.security,
                ask: execDefaults.ask,
                node: execDefaults.node,
                elevated: params.bashElevated,
              }
            : undefined,
          scheduledToolPolicy: params.scheduledToolPolicy,
          toolConstructionPlan: {
            includeBaseCodingTools: includeMediatedBaseCodingTools,
            includeShellTools: includeMediatedShellTools,
            includeChannelTools: false,
            includeOpenClawTools: false,
            includePluginTools: false,
          },
        })
      : [];
  assertCurrent();
  // CLI backends already own their local shell. This extra surface is deliberately
  // fixed to node so it cannot become a second path to Gateway-local execution.
  const baseTools = nodeExecSurface
    ? openClawTools.filter((tool) => tool.name.trim().toLowerCase() !== "exec")
    : openClawTools;
  const toolsWithMediatedCoding = [
    // Once a name is server-minted as mediated, only the canonical coding
    // factory may supply it. A policy-filtered tool must not fall back to a
    // coincidentally named Gateway/plugin implementation.
    ...baseTools.filter((tool) => !mediatedToolNames.has(normalizeToolPolicyName(tool.name))),
    ...mediatedCodingTools,
  ];
  const allTools = nodeExecDefaults
    ? [
        ...toolsWithMediatedCoding,
        createLazyExecTool(
          {
            host: "node",
            mode: nodeExecDefaults.mode,
            security: nodeExecDefaults.security,
            ask: nodeExecDefaults.ask,
            trigger: params.trigger,
            node: nodeExecDefaults.node,
            pathPrepend: execConfig?.pathPrepend,
            safeBins: execConfig?.safeBins,
            strictInlineEval: execConfig?.strictInlineEval,
            commandHighlighting: execConfig?.commandHighlighting,
            safeBinTrustedDirs: execConfig?.safeBinTrustedDirs,
            safeBinProfiles: execConfig?.safeBinProfiles,
            reviewer: execConfig?.reviewer,
            config: params.cfg,
            agentId: policyAgentId,
            elevated: params.bashElevated,
            cwd: workspaceDir,
            allowBackground: false,
            scopeKey: params.sessionKey,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            sessionStore: params.cfg.session?.store,
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
              "Execute a shell command on a connected OpenClaw node. This tool is node-only; use the CLI native shell for Gateway-local commands when it is available. Commands run synchronously. The sole connected node that can execute commands is selected automatically; set node when several can.",
            displaySummary: "Run commands on a connected node",
            parameters: nodeExecSchema,
          },
        ),
      ]
    : toolsWithMediatedCoding;

  const toolsForMessageProvider = filterToolsByMessageProvider(allTools, params.messageProvider);
  let nativeCreatorTools = (params.nativeCronCreatorToolAllowlist ?? []).map((name) => ({ name }));
  const declaredToolAllowlist = buildDeclaredToolAllowlistContext({
    config: params.cfg,
    workspaceDir,
    toolDenylist: explicitDenylist,
  });
  function filterGatewayToolPolicies(
    config: OpenClawConfig,
    onFilter?: Parameters<typeof applyToolPolicyPipeline>[0]["onFilter"],
  ): AnyAgentTool[] {
    const current =
      config === params.cfg ? configuredToolPolicies : resolveConfiguredToolPolicies(config);
    return applyToolPolicyPipeline({
      tools: toolsForMessageProvider,
      toolMeta: (tool: AnyAgentTool) => getPluginToolMeta(tool),
      warn: logWarn,
      steps: [
        ...buildDefaultToolPolicyPipelineSteps({
          profilePolicy: current.profilePolicyWithAlsoAllow,
          profile: current.profile,
          profileUnavailableCoreWarningAllowlist: current.profilePolicy?.allow,
          providerProfilePolicy: current.providerProfilePolicyWithAlsoAllow,
          providerProfile: current.providerProfile,
          providerProfileUnavailableCoreWarningAllowlist: current.providerProfilePolicy?.allow,
          globalPolicy: current.globalPolicy,
          globalProviderPolicy: current.globalProviderPolicy,
          agentPolicy: current.agentPolicy,
          agentProviderPolicy: current.agentProviderPolicy,
          groupPolicy,
          senderPolicy,
          agentId: policyAgentId,
        }),
        { policy: sandboxPolicy, label: "sandbox tools.allow" },
        { policy: subagentPolicy, label: "subagent tools.allow" },
        { policy: inheritedToolPolicy, label: "inherited tools" },
      ],
      declaredToolAllowlist,
      onFilter,
    });
  }
  const policyFiltered = filterGatewayToolPolicies(params.cfg, ({ policy }) => {
    nativeCreatorTools = filterToolsByPolicy(nativeCreatorTools, policy);
  });

  const gatewayDenySet = new Set(
    [
      ...defaultGatewayDeny,
      ...ownerOnlyGatewayDeny,
      ...(Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : []),
      ...excludedToolNames,
    ].map(normalizeToolPolicyName),
  );
  const tools = applySwarmCollectorToolContract(
    applyDelegationCapability(
      policyFiltered.filter((tool) => !gatewayDenySet.has(normalizeToolPolicyName(tool.name))),
      params.delegationCapability,
    ),
    {
      swarmCollector: Boolean(swarmCollectorContext),
      structuredOutputTool: openClawTools.find((tool) => tool.name === "structured_output"),
    },
  );
  // The loopback exec tool is node-only. Do not let a raw `exec` capability get
  // reinterpreted as generic Gateway/sandbox exec by spawned sessions or cron jobs.
  const inheritableTools = includeNodeExecTool
    ? tools.filter((tool) => tool.name.trim().toLowerCase() !== "exec")
    : tools;
  if (shouldInheritEffectiveToolAllowlist) {
    replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, inheritableTools);
  }
  const nativeCapture = {
    canonicalToolNames: params.nativeCronCreatorToolAllowlist,
    // The loopback grant carries native authority only for Gateway-placed CLI runs.
    nativeExecTarget: { host: "gateway" as const },
  };
  replaceWithEffectiveCronCreatorToolAllowlist(
    cronCreatorToolAllowlist,
    inheritableTools,
    (tool) => getPluginToolMeta(tool),
    nativeCapture,
  );

  return {
    agentId: sessionAgentId,
    tools: applyToolAvailabilityDescriptions(filterRequesterYieldTools(tools, params.sessionKey)),
    workspaceDir,
    // Only the MCP owner knows which tools survived its grant and schema gates.
    captureFinalCronCreatorTools: cronCreatorToolAllowlistCaptureRef
      ? (callableToolNames: ReadonlySet<string>) =>
          captureFinalEffectiveCronCreatorToolAllowlist(
            cronCreatorToolAllowlist,
            cronCreatorToolAllowlistCaptureRef,
            inheritableTools.filter((tool) => callableToolNames.has(tool.name.trim())),
            (tool) => getPluginToolMeta(tool),
            {
              ...nativeCapture,
              canonicalToolNames: nativeCreatorTools.map((tool) => tool.name),
            },
          )
      : undefined,
  };
}
