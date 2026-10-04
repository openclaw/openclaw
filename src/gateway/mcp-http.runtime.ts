// MCP loopback runtime scope cache.
// Resolves Gateway-visible tools for MCP clients with short-lived schema caching.
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import {
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import { resolveSessionAgentIds } from "../agents/agent-scope.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  loadPairedComputerUseAvailabilityForSurface,
  type PairedComputerUseAvailability,
} from "../agents/computer-use-node-capabilities.js";
import {
  isCoreCodingSurfaceToolName,
  listCoreToolFactoryDescriptors,
} from "../agents/core-tool-factory-descriptors.js";
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { loadNodeExecAvailability } from "../agents/node-exec-availability.js";
import type { PreparedRootedExecutionCapability } from "../agents/rooted-run-params.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import { getInProcessGatewayToolContext } from "../agents/tools/in-process-gateway.js";
import { hasSessionControlAuthority } from "../agents/tools/sessions-operator-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DirectoryCache } from "../infra/outbound/directory-cache.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
import type { McpLoopbackRequestContext } from "./mcp-grant-store.js";
import {
  buildMcpToolSchema,
  readMcpLoopbackToolName,
  type McpLoopbackTool,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";
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
};

type McpLoopbackScopeParams = {
  admittedRunContext?: AdmittedRunContext;
  context: Omit<McpLoopbackRequestContext, "senderIsOwner"> & { senderIsOwner?: boolean };
  cfg: OpenClawConfig;
  authProfileStore?: AuthProfileStore;
  authProfileStoreAgentDir?: string;
  skillLibraryAuthoring?: SkillLibraryAuthoringCapability;
  rootedExecution?: PreparedRootedExecutionCapability;
  /** Host-selected coding owners for pre-grant projection only. */
  defaultMediatedToolNames?: readonly string[];
  messageActionTurnCapability?: string;
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

function captureMcpLoopbackScope(params: McpLoopbackScopeParams) {
  const canPreparePortal =
    params.context.senderIsOwner === false &&
    Boolean(params.context.sessionKey.trim() && params.context.sessionId) &&
    !params.rootedExecution?.sandbox;
  const gateway = canPreparePortal ? getInProcessGatewayToolContext() : undefined;
  const projection = gateway ? getSessionRowProjection(gateway) : undefined;
  const assertCurrent = () => {
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
  };
  assertCurrent();
  return { ...params, projection, assertCurrent };
}

type CapturedMcpLoopbackScope = ReturnType<typeof captureMcpLoopbackScope>;

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

function isMcpCatalogSessionCurrent(catalog: CachedScopedTools, params: CapturedMcpLoopbackScope) {
  const current = captureMcpCatalogSessionFacts(params);
  return (
    catalog.sessionFacts?.projection === current?.projection &&
    catalog.sessionFacts?.generation === current?.generation &&
    catalog.sessionFacts?.revision === current?.revision
  );
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
  if (
    toolsAllow === undefined ||
    toolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*")
  ) {
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
    !params.rootedExecution &&
    !params.context.trustedInternalHandoff &&
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

function isComputerAllowedByMcpScope(
  params: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): boolean {
  const { toolsAllow } = params.context;
  if (mode === "exact") {
    return (
      toolsAllow === undefined ||
      toolsAllow.some((name) => normalizeToolPolicyName(name) === "computer")
    );
  }
  return applyEmbeddedAttemptToolsAllow([{ name: "computer" }], toolsAllow).length === 1;
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
    isComputerAllowedByMcpScope(params, mode) &&
    params.context.modelHasVision !== false &&
    !params.rootedExecution;
  if (!canReachOrdinaryComputerSurface) {
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
    computerAllowed,
    modelHasVision: params.context.modelHasVision,
    computerTransport: params.rootedExecution ? null : undefined,
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
  return pairedComputerUseAvailability.prepared
    ? resolvedParams
    : { ...resolvedParams, policyResolved };
}

async function resolveMcpLoopbackTools(
  params: CapturedMcpLoopbackScope,
  mode: LoopbackToolsAllowMode,
  policyResolved?: CachedScopedTools,
): Promise<CachedScopedTools> {
  return withReadyMcpSession(params, () =>
    policyResolved && isMcpCatalogSessionCurrent(policyResolved, params)
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
  return await withReadySessionRows(
    params.projection,
    () => [{ agentId, key: sessionKey }],
    () => {
      params.assertCurrent();
      return consume();
    },
  );
}

function constructMcpLoopbackTools(
  params: CapturedMcpLoopbackScope,
  mode: LoopbackToolsAllowMode,
): CachedScopedTools {
  params.assertCurrent();
  // Capture the row used by this synchronous construction before a factory can reenter.
  const sessionFacts = captureMcpCatalogSessionFacts(params);
  const { toolsAllow, webSearchDisabled, ...context } = params.context;
  const excludeToolNames = new Set(NATIVE_TOOL_EXCLUDE);
  if (webSearchDisabled) {
    excludeToolNames.add("web_search");
  }
  // Restricted CLI grants use OpenClaw's implementations for coding tools;
  // native CLI tools bypass path, approval, sandbox, and exec policy.
  const mediatedNativeTools =
    params.rootedExecution || context.trustedInternalHandoff
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
  const skillWorkshop =
    context.skillWorkshop || params.skillLibraryAuthoring
      ? { ...context.skillWorkshop, libraryAuthoring: params.skillLibraryAuthoring }
      : undefined;
  const scoped = resolveGatewayScopedTools({
    ...context,
    rootedExecution: params.rootedExecution,
    messageActionTurnCapability: params.messageActionTurnCapability,
    cfg: params.cfg,
    authProfileStore: params.authProfileStore,
    onYield: params.onYield,
    skillWorkshop,
    nativeCronCreatorToolAllowlist: context.nativeCronCreatorToolAllowlist ?? undefined,
    agentDir: params.authProfileStoreAgentDir,
    conversationReadOrigin: "delegated",
    surface: "loopback",
    admittedRunContext: params.admittedRunContext,
    isGrantCurrent: params.isGrantCurrent,
    excludeToolNames,
    mediatedToolNames: mediatedNativeTools,
    includeNodeExecTool,
    nodeExecAvailable: params.nodeExecAvailability?.isAvailable,
    pairedNodeComputerUse: params.pairedComputerUseAvailability?.prepared,
  });
  const tools =
    mode === "exact"
      ? applyGrantToolsAllow(scoped.tools, toolsAllow)
      : applyPolicyToolsAllow(scoped.tools, toolsAllow);
  const toolSchema = buildMcpToolSchema(tools);
  scoped.captureFinalCronCreatorTools?.(new Set(toolSchema.map((tool) => tool.name)));
  return {
    agentId: scoped.agentId,
    workspaceDir: scoped.workspaceDir,
    tools,
    toolSchema,
    sessionFacts,
  };
}

async function resolveMcpLoopbackCatalog(
  params: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): Promise<CachedScopedTools> {
  const resolved = await resolvePairedComputerNodeScope(
    await resolveNodeExecScope(captureMcpLoopbackScope(params), mode),
    mode,
  );
  for (;;) {
    const tools = await resolveMcpLoopbackTools(resolved.params, mode, resolved.policyResolved);
    resolved.params.assertCurrent();
    if (isMcpCatalogSessionCurrent(tools, resolved.params)) {
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
        context.delegationCapability === "report_only" ? "report_only" : undefined,
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
    const nodeExecParams = await resolveNodeExecScope(captureMcpLoopbackScope(input), "exact");
    for (;;) {
      nodeExecParams.assertCurrent();
      // A policy-excluded computer scope has no inventory component. It can use
      // the ordinary cached catalog without touching Gateway again.
      const preDiscoveryCacheKey = buildMcpLoopbackToolCacheKey(nodeExecParams);
      let preDiscoveryCached = this.#entries.get(preDiscoveryCacheKey, nodeExecParams.cfg);
      if (preDiscoveryCached) {
        preDiscoveryCached = await withReadyMcpSession(nodeExecParams, () => {
          const cached = this.#entries.get(preDiscoveryCacheKey, nodeExecParams.cfg);
          return cached && isMcpCatalogSessionCurrent(cached, nodeExecParams) ? cached : undefined;
        });
        nodeExecParams.assertCurrent();
        if (preDiscoveryCached && isMcpCatalogSessionCurrent(preDiscoveryCached, nodeExecParams)) {
          return preDiscoveryCached;
        }
      }

      // Availability belongs to the current connection, not the schema TTL.
      const resolved = await resolvePairedComputerNodeScope(nodeExecParams, "exact");
      nodeExecParams.assertCurrent();
      const { params } = resolved;
      const cacheKey = buildMcpLoopbackToolCacheKey(params);
      const nextEntry = await withReadyMcpSession(params, () => {
        const cached = this.#entries.get(cacheKey, params.cfg);
        if (cached && isMcpCatalogSessionCurrent(cached, params)) {
          return cached;
        }
        const next =
          resolved.policyResolved && isMcpCatalogSessionCurrent(resolved.policyResolved, params)
            ? resolved.policyResolved
            : constructMcpLoopbackTools(params, "exact");
        params.assertCurrent();
        // Revocation may overtake discovery before a grant owns any cached rows.
        if (epoch === this.#epoch) {
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
      if (isMcpCatalogSessionCurrent(nextEntry, params)) {
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
