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
import { pickSandboxToolPolicy } from "../agents/sandbox-tool-policy.js";
import { normalizeToolPolicyName, toolPolicyRestrictsTools } from "../agents/tool-policy.js";
import { getInProcessGatewayToolContext } from "../agents/tools/in-process-gateway.js";
import { hasSessionControlAuthority } from "../agents/tools/sessions-operator-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { DirectoryCache } from "../infra/outbound/directory-cache.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
import type {
  McpLoopbackClientGrantCloseReason,
  McpLoopbackRequestContext,
} from "./mcp-grant-store.js";
import {
  createScopedToolsCleanupOwner,
  McpLoopbackGrantRows,
  type GrantResources,
  type ScopedToolsCleanup,
} from "./mcp-http.grant-rows.js";
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
  // Grant-owned rows only: drains the node resources the tool instances
  // registered (a computer execution opens on the first screenshot). Idempotent.
  dispose?: ScopedToolsCleanup;
};

type McpLoopbackScopeParams = {
  admittedRunContext?: AdmittedRunContext;
  context: Omit<McpLoopbackRequestContext, "senderIsOwner"> & { senderIsOwner?: boolean };
  cfg: OpenClawConfig;
  authProfileStore?: AuthProfileStore;
  authProfileStoreAgentDir?: string;
  skillLibraryAuthoring?: SkillLibraryAuthoringCapability;
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
  /** Owner-scoped computer execution identity; absent from the cache key like the grant liveness. */
  computerExecutionId?: string;
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
    Boolean(params.context.sessionKey.trim() && params.context.sessionId);
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
    isComputerAllowedByMcpScope(params, mode) && params.context.modelHasVision !== false;
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
  // Rebuild computer with the prepared host/node action projection and target
  // status. A discarded probe row never bound a node, so it holds nothing to release.
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
  const { toolsAllow, webSearchDisabled, ...context } = params.context;
  const excludeToolNames = new Set(NATIVE_TOOL_EXCLUDE);
  if (webSearchDisabled) {
    excludeToolNames.add("web_search");
  }
  // Restricted CLI grants use OpenClaw's implementations for coding tools;
  // native CLI tools bypass path, approval, sandbox, and exec policy.
  const mediatedNativeTools =
    context.trustedInternalHandoff ||
    toolPolicyRestrictsTools(pickSandboxToolPolicy(context.conversationToolPolicy))
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
  const skillWorkshop = params.skillLibraryAuthoring
    ? { libraryAuthoring: params.skillLibraryAuthoring }
    : undefined;
  // Only grant-owned rows get a cleanup owner. Runtime-token callers (the
  // owner/non-owner bearer, used for probes and listings) have no run to end,
  // so they keep the untracked per-row execution they had before, and no owner
  // means no execution-owned actions in their schema.
  const cleanupOwner = params.computerExecutionId ? createScopedToolsCleanupOwner() : undefined;
  const scopeOptions: Parameters<typeof resolveGatewayScopedTools>[0] = {
    ...context,
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
    registerRunCleanup: cleanupOwner?.register,
    computerExecutionId: params.computerExecutionId,
  };
  const scoped = await resolveGatewayScopedTools(scopeOptions, params.assertCurrent);
  params.assertCurrent();
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
    ...(cleanupOwner ? { dispose: cleanupOwner.dispose } : {}),
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

function hasComputerTool(row: CachedScopedTools): boolean {
  return row.tools.some((tool) => readMcpLoopbackToolName(tool) === "computer");
}

/** Short-lived cache for loopback tool lists keyed by session/channel context. */
export class McpLoopbackToolCache {
  // Rows without a client grant: schema-only rows under the short TTL.
  #entries = new DirectoryCache<CachedScopedTools>(TOOL_CACHE_TTL_MS, TOOL_CACHE_MAX_ENTRIES);
  // Rows with a client grant live with the grant until it is revoked. The global
  // cap still bounds them; a row the cap drops is rebuilt on the same execution.
  #grants = new McpLoopbackGrantRows<CachedScopedTools>(TOOL_CACHE_MAX_ENTRIES);
  // Concurrent misses for one grant scope share a single construction, so one
  // request cannot screenshot on a row another request's publication discards.
  // The entry remembers which authority it observed: a request under replaced
  // or retired authority starts its own build instead of joining a stale one.
  #inflight = new Map<
    string,
    {
      grant: GrantResources<CachedScopedTools>;
      generation: number;
      cfg: OpenClawConfig;
      pending: Promise<CachedScopedTools>;
    }
  >();
  #epoch = 0;

  #lookup(
    grant: GrantResources<CachedScopedTools> | undefined,
    cacheKey: string,
    cfg: OpenClawConfig,
  ): CachedScopedTools | undefined {
    return grant ? this.#grants.lookup(grant, cacheKey, cfg) : this.#entries.get(cacheKey, cfg);
  }

  async resolve(input: McpLoopbackScopeParams): Promise<CachedScopedTools> {
    const epoch = this.#epoch;
    // Capture refuses a grant revoked before this resolve, so only live grants are tracked.
    const captured = captureMcpLoopbackScope(input);
    const grantToken = input.grantToken;
    const grant = grantToken ? this.#grants.acquire(grantToken) : undefined;
    // Authority replaced during any discovery below must keep this row unpublished.
    const generation = grant?.generation ?? 0;
    const nodeExecParams = await resolveNodeExecScope(
      grant ? { ...captured, computerExecutionId: grant.computerExecutionId } : captured,
      "exact",
    );
    for (;;) {
      nodeExecParams.assertCurrent();
      // A policy-excluded computer scope has no inventory component. It can use
      // the ordinary cached catalog without touching Gateway again.
      const preDiscoveryCacheKey = buildMcpLoopbackToolCacheKey(nodeExecParams);
      if (this.#lookup(grant, preDiscoveryCacheKey, nodeExecParams.cfg)) {
        const preDiscoveryCached = await withReadyMcpSession(nodeExecParams, () => {
          const cached = this.#lookup(grant, preDiscoveryCacheKey, nodeExecParams.cfg);
          return cached && isMcpCatalogSessionCurrent(cached, nodeExecParams) ? cached : undefined;
        });
        nodeExecParams.assertCurrent();
        if (preDiscoveryCached && isMcpCatalogSessionCurrent(preDiscoveryCached, nodeExecParams)) {
          return grant
            ? await this.#serveGrantRow(preDiscoveryCached, input.signal)
            : preDiscoveryCached;
        }
      }

      const nextEntry =
        grantToken && grant
          ? await this.#joinGrantRow(
              grantToken,
              grant,
              generation,
              preDiscoveryCacheKey,
              nodeExecParams,
              input.signal,
            )
          : await this.#resolveUntrackedRow(nodeExecParams, epoch);
      nodeExecParams.assertCurrent();
      if (isMcpCatalogSessionCurrent(nextEntry, nodeExecParams)) {
        return nextEntry;
      }
    }
  }

  async #resolveUntrackedRow(
    nodeExecParams: CapturedMcpLoopbackScope,
    epoch: number,
  ): Promise<CachedScopedTools> {
    // Availability belongs to the current connection, not the schema TTL.
    const resolved = await resolvePairedComputerNodeScope(nodeExecParams, "exact");
    nodeExecParams.assertCurrent();
    const { params } = resolved;
    const cacheKey = buildMcpLoopbackToolCacheKey(params);
    return await withReadyMcpSession(params, async () => {
      const cached = this.#entries.get(cacheKey, params.cfg);
      if (cached && isMcpCatalogSessionCurrent(cached, params)) {
        return cached;
      }
      const next =
        resolved.policyResolved && isMcpCatalogSessionCurrent(resolved.policyResolved, params)
          ? resolved.policyResolved
          : await constructMcpLoopbackTools(params, "exact");
      params.assertCurrent();
      // Clearing may overtake discovery before the row is cached.
      if (epoch === this.#epoch && isMcpCatalogSessionCurrent(next, params)) {
        this.#entries.set(cacheKey, next, params.cfg);
      }
      return next;
    });
  }

  /**
   * Joins the shared build for this grant scope, or starts it. The build belongs
   * to the cache, not to the request that started it: it runs without any
   * request's signal and stays joinable until it settles, while each caller
   * stops waiting as soon as its own request is cancelled.
   */
  async #joinGrantRow(
    grantToken: string,
    grant: GrantResources<CachedScopedTools>,
    generation: number,
    preDiscoveryCacheKey: string,
    nodeExecParams: CapturedMcpLoopbackScope,
    signal: AbortSignal | undefined,
  ): Promise<CachedScopedTools> {
    const inflight = this.#inflight.get(preDiscoveryCacheKey);
    const pending =
      inflight?.grant === grant &&
      inflight.generation === generation &&
      inflight.cfg === nodeExecParams.cfg
        ? inflight.pending
        : this.#startGrantBuild(
            grantToken,
            grant,
            generation,
            preDiscoveryCacheKey,
            nodeExecParams,
          );
    return await racePromiseWithAbortSignal(pending, signal, (aborted) => aborted.reason);
  }

  #startGrantBuild(
    grantToken: string,
    grant: GrantResources<CachedScopedTools>,
    generation: number,
    preDiscoveryCacheKey: string,
    nodeExecParams: CapturedMcpLoopbackScope,
  ): Promise<CachedScopedTools> {
    const pending = this.#resolveGrantRow(
      grantToken,
      grant,
      generation,
      captureMcpLoopbackScope({ ...nodeExecParams, signal: undefined }),
    );
    this.#inflight.set(preDiscoveryCacheKey, {
      grant,
      generation,
      cfg: nodeExecParams.cfg,
      pending,
    });
    const settle = () => {
      if (this.#inflight.get(preDiscoveryCacheKey)?.pending === pending) {
        this.#inflight.delete(preDiscoveryCacheKey);
      }
    };
    void pending.then(settle, settle);
    return pending;
  }

  /**
   * A retired predecessor's close must reach the node before a grant row's next
   * screenshot, or the provider still reports the old execution busy. Applies
   * to cached rows as well: a successor may have built its row while the
   * predecessor was still running.
   */
  async #serveGrantRow(row: CachedScopedTools, signal?: AbortSignal): Promise<CachedScopedTools> {
    if (this.#grants.hasPendingDisposals && hasComputerTool(row)) {
      await this.#grants.settleDisposals(signal);
      signal?.throwIfAborted();
    }
    return row;
  }

  async #resolveGrantRow(
    grantToken: string,
    grant: GrantResources<CachedScopedTools>,
    generation: number,
    nodeExecParams: CapturedMcpLoopbackScope,
  ): Promise<CachedScopedTools> {
    // Availability belongs to the current connection, not the schema TTL.
    const resolved = await resolvePairedComputerNodeScope(nodeExecParams, "exact");
    nodeExecParams.assertCurrent();
    const { params } = resolved;
    const cacheKey = buildMcpLoopbackToolCacheKey(params);
    const nextEntry = await withReadyMcpSession(params, async () => {
      const cached = this.#grants.lookup(grant, cacheKey, params.cfg);
      if (cached && isMcpCatalogSessionCurrent(cached, params)) {
        return cached;
      }
      const next =
        resolved.policyResolved && isMcpCatalogSessionCurrent(resolved.policyResolved, params)
          ? resolved.policyResolved
          : await constructMcpLoopbackTools(params, "exact");
      if (isMcpCatalogSessionCurrent(next, params)) {
        this.#grants.publish(grantToken, grant, generation, cacheKey, params.cfg, next);
      }
      return next;
    });
    return await this.#serveGrantRow(nextEntry);
  }

  /**
   * The authority behind a live token was replaced: its rows captured the old
   * authority and must go, but the node execution the run drives stays open.
   */
  evictGrant(token: string): boolean {
    this.#epoch += 1;
    return this.#grants.evict(token);
  }

  /** The run moved onto a successor token; its execution and cleanups move with it. */
  transferGrant(token: string, successorToken: string): void {
    this.#epoch += 1;
    this.#grants.transfer(token, successorToken);
  }

  /** The run the token served ended; close the node execution with its real outcome. */
  revokeGrant(token: string, closeReason: McpLoopbackClientGrantCloseReason): boolean {
    this.#epoch += 1;
    return this.#grants.revoke(token, closeReason);
  }

  /**
   * Drops every row. The loopback server revokes its grants before clearing, so
   * this normally only waits for their closes; a grant still tracked here is
   * cancelled as well so nothing outlives the cache.
   */
  async clear(): Promise<void> {
    this.#epoch += 1;
    this.#entries.clear();
    await this.#grants.clear();
  }
}
