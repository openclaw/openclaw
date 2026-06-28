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
  HOST_FS_BUILTIN_CODING_DENY_NAMES,
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
  const defaultGatewayDeny: string[] =
    surface === "http"
      ? DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter((name) => !gatewayToolsCfg?.allow?.includes(name))
      : [];
  const ownerOnlyGatewayDeny: string[] =
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
  const hostFsBuiltinCodingDeny = new Set<string>(HOST_FS_BUILTIN_CODING_DENY_NAMES);
  // The host-FS coding names (`read`/`write`/`edit`) gate the BUILT-IN coding tool
  // at the final gateway deny filter, which preserves a same-named PLUGIN tool. They
  // must NOT be passed to the plugin loader's denylist, or the production plugin
  // resolver drops a same-named plugin tool by name before it can reach that filter
  // (clawsweeper #63919 [P1]). Names denied for any OTHER reason (explicit
  // `gateway.tools.deny`, owner-only, or excluded) stay in the plugin denylist.
  const gatewayConfiguredDeny = Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : [];
  const pluginToolDenylist = explicitDenylist.filter((name) => {
    if (!hostFsBuiltinCodingDeny.has(name)) {
      return true;
    }
    const deniedOnlyByHostFsDefault =
      defaultGatewayDeny.includes(name) &&
      !ownerOnlyGatewayDeny.includes(name) &&
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
    pluginToolDenylist,
    cronCreatorToolAllowlist: shouldCaptureCronCreatorToolAllowlist
      ? cronCreatorToolAllowlist
      : undefined,
    inheritedToolAllowlist,
    inheritedToolDenylist,
  });

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
    // host-FS built-in coding default-deny (`read`/`write`/`edit`). That default
    // exists to gate the BUILT-IN coding tool (which has no plugin meta) behind
    // the directInvoke opt-in — not to break a plugin tool the operator
    // allowlisted. The built-in stays denied; any OTHER deny reason
    // (owner-only, explicit `gateway.tools.deny`, excluded, or the inherently
    // dangerous names like `exec`/`fs_write`) still drops the tool.
    const deniedOnlyByHostFsBuiltinDefault =
      hostFsBuiltinCodingDeny.has(tool.name) &&
      defaultGatewayDeny.includes(tool.name) &&
      !ownerOnlyGatewayDeny.includes(tool.name) &&
      !explicitGatewayDeny.includes(tool.name) &&
      !excludedToolNames.includes(tool.name);
    return deniedOnlyByHostFsBuiltinDefault && getPluginToolMeta(tool) !== undefined;
  });
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
