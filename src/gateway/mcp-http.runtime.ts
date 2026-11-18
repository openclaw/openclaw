import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import {
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import { resolveSessionAgentIds } from "../agents/agent-scope.js";
import { projectAgentToolRuntimeListing } from "../agents/agent-tool-runtime-listing.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  loadPairedComputerUseAvailabilityForSurface,
  omitUnsupportedNodeTools,
  type PairedComputerUseAvailability,
} from "../agents/computer-use-node-capabilities.js";
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { loadNodeExecAvailability } from "../agents/node-exec-availability.js";
import { pickSandboxToolPolicy } from "../agents/sandbox-tool-policy.js";
import { prepareSessionCapabilityRead } from "../agents/subagents/spawn/subagent-session-store.js";
import {
  isCoreCodingSurfaceToolName,
  listCoreToolFactoryDescriptors,
} from "../agents/tool-catalog.js";
import { normalizeToolPolicyName, toolPolicyRestrictsTools } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { getInProcessGatewayToolContext } from "../agents/tools/in-process-gateway.js";
import { hasSessionControlAuthority } from "../agents/tools/sessions-operator-authority.js";
import type { SessionEventSourcePolicy } from "../auto-reply/reply/session-event-contract.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DirectoryCache } from "../infra/outbound/directory-cache.js";
import type { MemoryAudience } from "../plugins/memory-provider-types.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
import type { McpLoopbackRequestContext } from "./mcp-grant-store.js";
import {
  buildMcpToolSchema,
  readMcpLoopbackToolName,
  type McpLoopbackTool,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";
import { readKnownNodeCatalog } from "./node-catalog-read.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { assertCompletionGrantLineage } from "./tool-resolution-completion.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

// MCP loopback runtime scopes gateway tools to the current session/channel
// context and caches the expensive schema projection for short bursts of tool
// list/call traffic from the same MCP client.
const TOOL_CACHE_TTL_MS = 30_000;
const TOOL_CACHE_MAX_ENTRIES = 256;
const NATIVE_TOOL_EXCLUDE = new Set(
  listCoreToolFactoryDescriptors()
    .map(({ name }) => name)
    .filter(isCoreCodingSurfaceToolName),
);

type CachedScopedTools = {
  agentId: string | undefined;
  // Tool policy resolves the workspace root (grant value, else the agent's
  // configured workspace). Hook context must carry the same one the tools were
  // built with, or before-tool-call policy resolves state against a different root.
  workspaceDir: string | undefined;
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
  sessionFacts: ReturnType<typeof captureMcpCatalogSessionFacts>;
  nodeFacts: Awaited<ReturnType<typeof captureMcpCatalogNodeFacts>>;
};

type McpLoopbackScopeParams = {
  admittedRunContext?: AdmittedRunContext;
  sessionEventSourcePolicy?: SessionEventSourcePolicy;
  context: Omit<McpLoopbackRequestContext, "senderIsOwner"> & { senderIsOwner?: boolean };
  cfg: OpenClawConfig;
  authProfileStore?: AuthProfileStore;
  authProfileStoreAgentDir?: string;
  skillLibraryAuthoring?: SkillLibraryAuthoringCapability;
  /** Run-owned configured MCP tools; only an exclusive CLI run supplies them. */
  bundledTools?: readonly AnyAgentTool[];
  /** Host-selected coding owners for pre-grant projection only. */
  defaultMediatedToolNames?: readonly string[];
  messageActionTurnCapability?: string;
  /** Memory audience of the authenticating run-bound grant; cached per grant token. */
  memoryAudience?: MemoryAudience;
  grantToken?: string;
  /**
   * Liveness of the authenticating client grant. Deliberately absent from the
   * cache key: the grant token is already in it, and every row replacement
   * evicts that token's cached tools, so a cached closure can only ever observe
   * the exact row it was built for.
   */
  isGrantCurrent?: () => boolean;
  yieldContextCacheKey?: string;
  onYield?: (message: string, acknowledgment?: string) => Promise<void> | void;
  nodeExecAvailability?: Awaited<ReturnType<typeof loadNodeExecAvailability>>;
  pairedComputerUseAvailability?: PairedComputerUseAvailability;
  signal?: AbortSignal;
};

type LoopbackToolsAllowMode = "exact" | "policy";

async function captureMcpLoopbackScope(params: McpLoopbackScopeParams) {
  const canPreparePortal =
    params.context.senderIsOwner === false &&
    Boolean(params.context.sessionKey.trim() && params.context.sessionId);
  const gateway = canPreparePortal ? getInProcessGatewayToolContext() : undefined;
  const projection = gateway ? getSessionRowProjection(gateway) : undefined;
  const prepared = await prepareSessionCapabilityRead(() => {
    params.signal?.throwIfAborted();
    assertCompletionGrantLineage(params);
    hasSessionControlAuthority(readAdmittedRunOperatorAuthority(params.admittedRunContext));
    if (params.isGrantCurrent?.() === false) {
      throw new Error("MCP tool grant is no longer current");
    }
    if (
      canPreparePortal &&
      (getInProcessGatewayToolContext() !== gateway ||
        getSessionRowProjection(gateway) !== projection)
    ) {
      throw new Error("MCP tool preparation belongs to a retired Gateway");
    }
  });
  return {
    ...params,
    projection,
    assertCurrent: prepared.read,
    [Symbol.dispose]: prepared.release,
  };
}

type CapturedMcpLoopbackScope = Awaited<ReturnType<typeof captureMcpLoopbackScope>>;

function captureMcpCatalogSessionFacts(params: CapturedMcpLoopbackScope) {
  if (!params.projection) {
    return undefined;
  }
  const { sessionAgentId: agentId } = resolveSessionAgentIds({
    config: params.cfg,
    sessionKey: params.context.sessionKey,
    agentId: params.context.agentId,
  });
  const row = params.projection.capture({ agentId, key: params.context.sessionKey });
  return {
    projection: params.projection,
    generation: row?.generation,
    revision: row?.databaseFactsRevision,
  };
}

function isMcpCatalogSessionCurrent(
  catalog: Pick<CachedScopedTools, "sessionFacts">,
  params: CapturedMcpLoopbackScope,
) {
  const current = captureMcpCatalogSessionFacts(params);
  return (
    catalog.sessionFacts?.projection === current?.projection &&
    catalog.sessionFacts?.generation === current?.generation &&
    catalog.sessionFacts?.revision === current?.revision
  );
}

/** Consume the existing local publication; never probe node transports for cache validity. */
async function captureMcpCatalogNodeFacts(params: CapturedMcpLoopbackScope) {
  const registry = getInProcessGatewayToolContext()?.nodeRegistry;
  const catalog = registry
    ? await readKnownNodeCatalog(registry).catch(() => undefined)
    : undefined;
  params.assertCurrent();
  return catalog?.nodes;
}

async function isMcpCatalogCurrent(catalog: CachedScopedTools, params: CapturedMcpLoopbackScope) {
  if (!isMcpCatalogSessionCurrent(catalog, params)) {
    return false;
  }
  const nodeFacts = await captureMcpCatalogNodeFacts(params);
  return catalog.nodeFacts === nodeFacts && isMcpCatalogSessionCurrent(catalog, params);
}

function resolveMediatedNativeTools(
  toolsAllow: string[] | undefined,
  mode: LoopbackToolsAllowMode,
): Set<string> {
  if (mode === "exact") {
    return new Set(
      (toolsAllow ?? [])
        .map((name) => normalizeToolPolicyName(name))
        .filter((name) => NATIVE_TOOL_EXCLUDE.has(name)),
    );
  }
  if (toolsAllow === undefined) {
    return new Set();
  }
  return new Set(
    applyEmbeddedAttemptToolsAllow(
      Array.from(NATIVE_TOOL_EXCLUDE, (name) => ({ name })),
      toolsAllow,
    ).map((tool) => tool.name),
  );
}

async function resolveNodeExecScope(
  params: CapturedMcpLoopbackScope,
  mode: LoopbackToolsAllowMode,
): Promise<CapturedMcpLoopbackScope> {
  const shouldResolveExec =
    !params.context.trustedInternalHandoff &&
    !toolPolicyRestrictsTools(pickSandboxToolPolicy(params.context.conversationToolPolicy)) &&
    params.context.nodeExecAllowed === true &&
    !params.defaultMediatedToolNames?.length &&
    resolveMediatedNativeTools(params.context.toolsAllow, mode).size === 0;
  if (!shouldResolveExec) {
    return params;
  }
  const nodeExecAvailability = await loadNodeExecAvailability(params.signal);
  params.assertCurrent();
  return { ...params, nodeExecAvailability };
}

function isNodeToolAllowedByMcpScope(
  params: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
  toolName: "computer" | "mobile_ui",
): boolean {
  const { toolsAllow } = params.context;
  if (mode === "exact") {
    return (
      toolsAllow === undefined ||
      toolsAllow.some((name) => normalizeToolPolicyName(name) === toolName)
    );
  }
  return applyEmbeddedAttemptToolsAllow([{ name: toolName }], toolsAllow).length === 1;
}

type ResolvedNodeScope = {
  params: CapturedMcpLoopbackScope;
  policyResolved?: CachedScopedTools;
};

async function resolvePairedComputerNodeScope(
  params: CapturedMcpLoopbackScope,
  mode: LoopbackToolsAllowMode,
): Promise<ResolvedNodeScope> {
  params.assertCurrent();
  const canReachOrdinaryComputerSurface =
    isNodeToolAllowedByMcpScope(params, mode, "computer") &&
    params.context.modelHasVision !== false;
  const canReachMobileUi = isNodeToolAllowedByMcpScope(params, mode, "mobile_ui");
  if (!canReachOrdinaryComputerSurface && !canReachMobileUi) {
    return { params };
  }
  // Resolve the actual configured surface before contacting Gateway. Grant policy
  // alone is insufficient: profile, agent, sandbox, sender, and Gateway policy
  // can all remove computer from the final catalog.
  const policyResolved = await resolveMcpLoopbackTools(params, mode);
  params.assertCurrent();
  const computerAllowed = policyResolved.tools.some(
    (tool) => readMcpLoopbackToolName(tool) === "computer",
  );
  const pairedComputerUseAvailability = await loadPairedComputerUseAvailabilityForSurface({
    config: params.cfg,
    computerAllowed,
    mobileUiAllowed: policyResolved.tools.some(
      (tool) => readMcpLoopbackToolName(tool) === "mobile_ui",
    ),
    modelHasVision: params.context.modelHasVision,
    signal: params.signal,
  });
  params.assertCurrent();
  if (!pairedComputerUseAvailability) {
    return { params, policyResolved };
  }
  const resolvedParams = {
    params: {
      ...params,
      pairedComputerUseAvailability,
    },
  };
  // Rebuild computer with the prepared host/node action projection and target status.
  return pairedComputerUseAvailability.prepared ||
    pairedComputerUseAvailability.unsupportedTools?.length
    ? resolvedParams
    : { ...resolvedParams, policyResolved };
}

async function resolveMcpLoopbackTools(
  params: CapturedMcpLoopbackScope,
  mode: LoopbackToolsAllowMode,
  policyResolved?: CachedScopedTools,
): Promise<CachedScopedTools> {
  return withReadyMcpSession(params, async () =>
    policyResolved && (await isMcpCatalogCurrent(policyResolved, params))
      ? policyResolved
      : constructMcpLoopbackTools(params, mode),
  );
}

async function withReadyMcpSession<T>(
  params: CapturedMcpLoopbackScope,
  consume: () => T,
): Promise<T> {
  params.assertCurrent();
  const { sessionKey, sessionId, senderIsOwner } = params.context;
  if (!params.projection || !sessionId || senderIsOwner !== false) {
    return consume();
  }
  const { sessionAgentId: agentId } = resolveSessionAgentIds({
    config: params.cfg,
    sessionKey,
    agentId: params.context.agentId,
  });
  let receipt: {
    sessionFacts: ReturnType<typeof captureMcpCatalogSessionFacts>;
    sharingRevision: object | undefined;
  };
  do {
    receipt = await withReadySessionRows(
      params.projection,
      () => [{ agentId, key: sessionKey }],
      () => {
        params.assertCurrent();
        return {
          sessionFacts: captureMcpCatalogSessionFacts(params),
          sharingRevision: params.projection?.sharingRevision,
        };
      },
    );
    params.assertCurrent();
  } while (
    receipt.sharingRevision === undefined ||
    receipt.sharingRevision !== params.projection.sharingRevision ||
    !isMcpCatalogSessionCurrent(receipt, params)
  );
  return consume();
}

async function constructMcpLoopbackTools(
  params: CapturedMcpLoopbackScope,
  mode: LoopbackToolsAllowMode,
): Promise<CachedScopedTools> {
  params.assertCurrent();
  // Retain the row identity so construction cannot publish facts from before an awaited read.
  const sessionFacts = captureMcpCatalogSessionFacts(params);
  const nodeFacts = await captureMcpCatalogNodeFacts(params);
  const { toolsAllow, webSearchDisabled, ...context } = params.context;
  const excludeToolNames = new Set(NATIVE_TOOL_EXCLUDE);
  if (webSearchDisabled) {
    excludeToolNames.add("web_search");
  }
  // Restricted CLI grants use OpenClaw's implementations for coding tools;
  // native CLI tools bypass path, approval, sandbox, and exec policy.
  const mediatedNativeTools =
    toolsAllow === undefined &&
    (context.trustedInternalHandoff ||
      toolPolicyRestrictsTools(pickSandboxToolPolicy(context.conversationToolPolicy)))
      ? new Set(NATIVE_TOOL_EXCLUDE)
      : resolveMediatedNativeTools(toolsAllow, mode);
  for (const toolName of params.defaultMediatedToolNames ?? []) {
    const name = normalizeToolPolicyName(toolName);
    if (!NATIVE_TOOL_EXCLUDE.has(name)) {
      throw new Error(`Unknown host-owned coding tool: ${toolName}`);
    }
    mediatedNativeTools.add(name);
  }
  for (const toolName of mediatedNativeTools) {
    excludeToolNames.delete(toolName);
  }
  const includeNodeExecTool = context.nodeExecAllowed === true && mediatedNativeTools.size === 0;
  if (includeNodeExecTool) {
    excludeToolNames.delete("exec");
  }
  const scopeOptions: Parameters<typeof resolveGatewayScopedTools>[0] = {
    ...context,
    messageActionTurnCapability: params.messageActionTurnCapability,
    memoryAudience: params.memoryAudience,
    toolsAllow,
    cfg: params.cfg,
    authProfileStore: params.authProfileStore,
    onYield: params.onYield,
    skillLibraryAuthoring: params.skillLibraryAuthoring,
    bundledTools: params.bundledTools,
    nativeCronCreatorToolAllowlist: context.nativeCronCreatorToolAllowlist ?? undefined,
    agentDir: params.authProfileStoreAgentDir,
    conversationReadOrigin: "delegated",
    surface: "loopback",
    admittedRunContext: params.admittedRunContext,
    sessionEventSourcePolicy: params.sessionEventSourcePolicy,
    isGrantCurrent: params.isGrantCurrent,
    excludeToolNames,
    mediatedToolNames: mediatedNativeTools,
    includeNodeExecTool,
    nodeExecAvailable: params.nodeExecAvailability?.isAvailable,
    pairedNodeComputerUse: params.pairedComputerUseAvailability?.prepared,
  };
  const scoped = await resolveGatewayScopedTools(scopeOptions, params.assertCurrent);
  params.assertCurrent();
  const eligibleTools =
    mode === "exact"
      ? applyGrantToolsAllow(scoped.tools, toolsAllow)
      : applyPolicyToolsAllow(scoped.tools, toolsAllow);
  const eligibleSchema = buildMcpToolSchema(eligibleTools);
  scoped.captureFinalCronCreatorTools?.(new Set(eligibleSchema.map((tool) => tool.name)));
  // A later child or cron run owns different targets. Capture policy/schema
  // eligibility above; current-host runtime omissions affect only this catalog.
  const tools = projectAgentToolRuntimeListing(
    omitUnsupportedNodeTools(eligibleTools, params.pairedComputerUseAvailability),
  );
  const eligibleNames = new Set(eligibleSchema.map((tool) => tool.name));
  const toolSchema = buildMcpToolSchema(tools.filter((tool) => eligibleNames.has(tool.name)));
  return {
    agentId: scoped.agentId,
    workspaceDir: scoped.workspaceDir,
    tools,
    toolSchema,
    sessionFacts,
    nodeFacts,
  };
}

async function resolveMcpLoopbackCatalog(
  params: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): Promise<CachedScopedTools> {
  using scope = await captureMcpLoopbackScope(params);
  const resolved = await resolvePairedComputerNodeScope(
    await resolveNodeExecScope(scope, mode),
    mode,
  );
  for (;;) {
    const tools = await resolveMcpLoopbackTools(resolved.params, mode, resolved.policyResolved);
    resolved.params.assertCurrent();
    if (await isMcpCatalogCurrent(tools, resolved.params)) {
      return tools;
    }
  }
}

/** Resolves loopback-visible tools from the exact names carried by a minted grant. */
export function resolveMcpLoopbackScopedTools(params: McpLoopbackScopeParams): Promise<{
  agentId: string | undefined;
  workspaceDir?: string;
  tools: McpLoopbackTool[];
}> {
  return resolveMcpLoopbackCatalog(params, "exact");
}

/** Materializes runtime policy expressions against the concrete loopback catalog. */
export function resolveMcpLoopbackPolicyTools(params: McpLoopbackScopeParams): Promise<{
  agentId: string | undefined;
  tools: McpLoopbackTool[];
}> {
  return resolveMcpLoopbackCatalog(params, "policy");
}

/**
 * Hard-enforces a per-run grant allowlist on the loopback surface. Both
 * tools/list and tools/call consume this list, so a tool outside the
 * allowlist can be neither discovered nor executed even when the CLI runs
 * with a bypass permission mode. An empty allowlist fails closed.
 */
function applyGrantToolsAllow(
  tools: McpLoopbackTool[],
  toolsAllow: string[] | undefined,
): McpLoopbackTool[] {
  if (!toolsAllow) {
    return tools;
  }
  const allowed = new Set(toolsAllow.map((name) => normalizeToolPolicyName(name)).filter(Boolean));
  return tools.filter((tool) => {
    const name = readMcpLoopbackToolName(tool);
    return name !== undefined && allowed.has(normalizeToolPolicyName(name));
  });
}

function applyPolicyToolsAllow(
  tools: McpLoopbackTool[],
  toolsAllow: string[] | undefined,
): McpLoopbackTool[] {
  if (!toolsAllow) {
    return tools;
  }
  // Grant lists remain exact; only this pre-mint path may expand groups,
  // globs, plugin ids, and write-to-apply_patch policy semantics.
  const candidates = tools.flatMap((tool) => {
    const name = readMcpLoopbackToolName(tool);
    return name ? [{ name, tool }] : [];
  });
  return applyEmbeddedAttemptToolsAllow(candidates, toolsAllow, {
    toolMeta: (candidate) => getPluginToolMeta(candidate.tool),
  }).map((candidate) => candidate.tool);
}

function buildMcpLoopbackToolCacheKey(params: McpLoopbackScopeParams): string {
  const { context } = params;
  // Only the serializable grant context enters this key. Prepared credentials,
  // authoring capabilities, and callbacks stay bound to their grant lifetime.
  return `${params.grantToken ?? ""}\u0000${stableStringify({
    context: {
      ...context,
      clientCaps: [...new Set(context.clientCaps ?? [])].toSorted(),
      // Missing allows all; an empty list denies all.
      toolsAllow: context.toolsAllow ? [...new Set(context.toolsAllow)].toSorted() : undefined,
      pinnedWidgetAuthoring: context.pinnedWidgetAuthoring === true,
      currentInboundAudio: context.currentInboundAudio === true,
      sourceReplyOnly: context.sourceReplyOnly === true,
      requireExplicitMessageTarget: context.requireExplicitMessageTarget === true,
      nodeExecAllowed: context.nodeExecAllowed === true,
      delegationCapability:
        context.delegationCapability === "full" ? undefined : context.delegationCapability,
    },
    admittedRunInstance: params.admittedRunContext?.operationalRunInstance,
    defaultMediatedToolNames: params.defaultMediatedToolNames,
    sessionControlsAllowed: hasSessionControlAuthority(
      readAdmittedRunOperatorAuthority(params.admittedRunContext),
    ),
    authProfileStoreAgentDir: params.authProfileStoreAgentDir,
    yieldContextCacheKey: params.yieldContextCacheKey,
    nodeExecAvailability: params.nodeExecAvailability?.cacheKey,
    pairedComputerUseAvailability: params.pairedComputerUseAvailability?.cacheKey,
  })}`;
}

/** Short-lived cache for loopback tool lists keyed by session/channel context. */
export class McpLoopbackToolCache {
  #entries = new DirectoryCache<CachedScopedTools>(TOOL_CACHE_TTL_MS, TOOL_CACHE_MAX_ENTRIES);
  // Revocation needs the config scopes where one grant may have cached tools.
  #grantConfigScopes = new Map<string, Set<OpenClawConfig>>();
  #epoch = 0;

  async resolve(input: McpLoopbackScopeParams): Promise<CachedScopedTools> {
    const epoch = this.#epoch;
    using scope = await captureMcpLoopbackScope(input);
    const nodeExecParams = await resolveNodeExecScope(scope, "exact");
    for (;;) {
      nodeExecParams.assertCurrent();
      // Plugin listings also depend on the local node publication, even when
      // built-in computer discovery is excluded by this grant.
      const preDiscoveryCacheKey = buildMcpLoopbackToolCacheKey(nodeExecParams);
      let preDiscoveryCached = this.#entries.get(preDiscoveryCacheKey, nodeExecParams.cfg);
      if (preDiscoveryCached) {
        preDiscoveryCached = await withReadyMcpSession(nodeExecParams, async () => {
          const cached = this.#entries.get(preDiscoveryCacheKey, nodeExecParams.cfg);
          return cached && (await isMcpCatalogCurrent(cached, nodeExecParams)) ? cached : undefined;
        });
        nodeExecParams.assertCurrent();
        if (preDiscoveryCached && (await isMcpCatalogCurrent(preDiscoveryCached, nodeExecParams))) {
          return preDiscoveryCached;
        }
      }

      // Availability belongs to the current connection, not the schema TTL.
      const resolved = await resolvePairedComputerNodeScope(nodeExecParams, "exact");
      nodeExecParams.assertCurrent();
      const { params } = resolved;
      const cacheKey = buildMcpLoopbackToolCacheKey(params);
      const nextEntry = await withReadyMcpSession(params, async () => {
        const cached = this.#entries.get(cacheKey, params.cfg);
        if (cached && (await isMcpCatalogCurrent(cached, params))) {
          return cached;
        }
        const next =
          resolved.policyResolved && (await isMcpCatalogCurrent(resolved.policyResolved, params))
            ? resolved.policyResolved
            : await constructMcpLoopbackTools(params, "exact");
        params.assertCurrent();
        // Revocation may overtake discovery before a grant owns any cached rows.
        if ((await isMcpCatalogCurrent(next, params)) && epoch === this.#epoch) {
          this.#entries.set(cacheKey, next, params.cfg);
          if (params.grantToken) {
            const scopes =
              this.#grantConfigScopes.get(params.grantToken) ?? new Set<OpenClawConfig>();
            scopes.add(params.cfg);
            this.#grantConfigScopes.set(params.grantToken, scopes);
          }
        }
        return next;
      });
      params.assertCurrent();
      if (await isMcpCatalogCurrent(nextEntry, params)) {
        return nextEntry;
      }
    }
  }

  evictGrant(token: string): boolean {
    this.#epoch += 1;
    const scopes = this.#grantConfigScopes.get(token);
    if (!scopes) {
      return false;
    }
    const cacheKeyPrefix = `${token}\u0000`;
    for (const cfg of scopes) {
      this.#entries.clearMatching((cacheKey) => cacheKey.startsWith(cacheKeyPrefix), cfg);
    }
    this.#grantConfigScopes.delete(token);
    return true;
  }

  clear(): void {
    this.#epoch += 1;
    this.#entries.clear();
    this.#grantConfigScopes.clear();
  }
}
