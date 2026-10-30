import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  validateToolsEffectiveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  buildBundleMcpToolsFromCatalog,
  peekSessionMcpRuntime,
  resolveSessionMcpConfigSummary,
} from "../../agents/agent-bundle-mcp-tools.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { prepareConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { resolveConversationToolPolicies } from "../../agents/conversation-tool-policy-pipeline.js";
import { applyFinalEffectiveToolPolicy } from "../../agents/embedded-agent-runner/effective-tool-policy.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import { listCoreToolSections } from "../../agents/tool-catalog.js";
import { readToolAllowlistIntersection } from "../../agents/tool-policy-shared.js";
import type { ToolPolicyLike } from "../../agents/tool-policy.js";
import { buildEffectiveToolInventoryGroups } from "../../agents/tools-effective-inventory-groups.js";
import { buildEffectiveToolInventory } from "../../agents/tools-effective-inventory-shared.js";
import {
  resolveEffectiveToolInventory,
  acquireEffectiveToolInventoryRuntimeModelContext,
} from "../../agents/tools-effective-inventory.js";
import type {
  EffectiveToolInventoryNotice,
  EffectiveToolInventoryResult,
} from "../../agents/tools-effective-inventory.types.js";
import { resolveSessionToolPreviewSandboxPolicy } from "../../agents/tools-effective-sandbox-policy.js";
import { resolveReplyToMode } from "../../auto-reply/reply/reply-threading.js";
import { resolveRuntimeConfigCacheKey } from "../../config/config.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import { toErrorObject } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { logDebug, logWarn } from "../../logger.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import {
  getActivePluginChannelRegistryVersion,
  getActivePluginRegistryVersion,
} from "../../plugins/runtime.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.read.js";
import { getConnectedNodePluginToolsVersion } from "../node-plugin-tool-snapshot.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { withGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
import { resolveSessionModelRef, type GatewaySessionEntryRead } from "../session-utils.js";
import { respondError } from "./response.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

type TrustedToolsEffectiveContext = NonNullable<
  Awaited<ReturnType<typeof resolveTrustedToolsEffectiveContext>>
>;

const TOOLS_EFFECTIVE_FRESH_TTL_MS = 10_000;
const TOOLS_EFFECTIVE_STALE_TTL_MS = 120_000;
const TOOLS_EFFECTIVE_SLOW_LOG_MS = 250;
const TOOLS_EFFECTIVE_CACHE_LIMIT = 128;
const MCP_CONFIG_SUMMARY_CACHE_LIMIT = 128;
const BUNDLE_MCP_PLUGIN_ID = "bundle-mcp";

// Static presentation only: the effective inventory still owns tool selection.
const coreToolDescriptions = new Map(
  listCoreToolSections({ swarmEnabled: true, personalInstructionsEnabled: true }).flatMap(
    (section) => section.tools.map((tool) => [tool.id, tool.description] as const),
  ),
);

function projectSessionToolPreview(
  inventory: EffectiveToolInventoryResult,
): EffectiveToolInventoryResult {
  return {
    agentId: inventory.agentId,
    profile: inventory.profile,
    groups: inventory.groups.map((group) => ({
      id: group.id,
      label: group.label,
      source: group.source,
      tools: group.tools.map((tool) => {
        // Runtime descriptions and notices can contain MCP launch details or host paths.
        const description =
          tool.source !== "core"
            ? ""
            : tool.id === "github_publish"
              ? tool.rawDescription // Its owner renders only the policy-filtered action names.
              : (coreToolDescriptions.get(tool.id) ?? "");
        return {
          id: tool.id,
          label: tool.id,
          source: tool.source,
          description,
          rawDescription: description,
          ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
          ...(tool.channelId ? { channelId: tool.channelId } : {}),
          ...(tool.source === "mcp"
            ? { mcpServer: tool.mcpServer, mcpToolName: tool.mcpToolName }
            : {}),
          ...(tool.deniedBySession ? { deniedBySession: true as const } : {}),
        };
      }),
    })),
  };
}

type ToolsEffectiveCacheEntry = {
  value: EffectiveToolInventoryResult;
  createdAtMs: number;
};

type SessionMcpConfigSummary = ReturnType<typeof resolveSessionMcpConfigSummary>;

const toolsEffectiveCache = new Map<string, ToolsEffectiveCacheEntry>();
const toolsEffectiveInflight = new Map<string, Promise<EffectiveToolInventoryResult>>();
const mcpConfigSummaryCache = new Map<string, SessionMcpConfigSummary>();

function optionalCacheString(value: string | undefined | null): string {
  return value?.trim() ?? "";
}

function buildToolsEffectiveCacheKey(context: TrustedToolsEffectiveContext): string {
  return JSON.stringify({
    v: 1,
    config: context.runtimeConfigCacheKey,
    pluginRegistry: context.pluginRegistryVersion,
    channelRegistry: context.channelRegistryVersion,
    nodePluginTools: context.nodePluginToolsVersion,
    // MCP fingerprint/server names intentionally stay out of this key: the MCP
    // layer is applied after the base cache, so warm/stale runtime state alone
    // never invalidates base entries.
    sessionKey: context.sessionKey,
    sessionId: context.sessionId,
    workspaceDir: optionalCacheString(context.workspaceDir),
    agentId: context.agentId,
    modelProvider: optionalCacheString(context.modelProvider),
    modelId: optionalCacheString(context.modelId),
    messageProvider: optionalCacheString(context.messageProvider),
    accountId: optionalCacheString(context.accountId),
    currentChannelId: optionalCacheString(context.currentChannelId),
    currentThreadTs: optionalCacheString(context.currentThreadTs),
    groupId: optionalCacheString(context.groupId),
    groupChannel: optionalCacheString(context.groupChannel),
    groupSpace: optionalCacheString(context.groupSpace),
    replyToMode: optionalCacheString(context.replyToMode),
    webSearchEnabled: context.toolOverrides?.webSearch !== false,
    // Prepared session ceilings can change without a config or session-id change.
    policy: Object.values<ToolPolicyLike | undefined>(
      resolveConversationToolPolicies({ capabilityProfile: context.capabilityProfile }),
    ).map(
      (policy) =>
        policy && {
          allow: policy.allow && (readToolAllowlistIntersection(policy.allow) ?? policy.allow),
          deny: policy.deny,
        },
    ),
  });
}

function resolveCachedSessionMcpConfigSummary(params: {
  context: TrustedToolsEffectiveContext;
  workspaceDir: string;
}): SessionMcpConfigSummary {
  const key = JSON.stringify({
    v: 1,
    config: params.context.runtimeConfigCacheKey,
    pluginRegistry: params.context.pluginRegistryVersion,
    workspaceDir: params.workspaceDir,
    toolOverrides: params.context.toolOverrides,
    toolDenylist: params.context.capabilityProfile.policy.explicitToolDenylist,
  });
  const cached = mcpConfigSummaryCache.get(key);
  if (cached) {
    return cached;
  }
  const summary = resolveSessionMcpConfigSummary({
    workspaceDir: params.workspaceDir,
    cfg: params.context.cfg,
    ...(params.context.toolOverrides ? { toolOverrides: params.context.toolOverrides } : {}),
    toolDenylist: params.context.capabilityProfile.policy.explicitToolDenylist,
  });
  mcpConfigSummaryCache.set(key, summary);
  pruneMapToMaxSize(mcpConfigSummaryCache, MCP_CONFIG_SUMMARY_CACHE_LIMIT);
  return summary;
}

// Base inventory resolution is pure CPU work, but it can still fan through
// config/model policy. Coalesce identical refreshes so UI polling does not
// recompute the same session inventory in parallel.
function scheduleBaseToolsEffectiveRefresh(
  key: string,
  context: TrustedToolsEffectiveContext,
): Promise<EffectiveToolInventoryResult> {
  const existing = toolsEffectiveInflight.get(key);
  if (existing) {
    return existing;
  }
  const startedAt = Date.now();
  const task = new Promise<EffectiveToolInventoryResult>((resolve, reject) => {
    setImmediate(() => {
      void resolveBaseToolsEffectiveInventory(context)
        .then((value) => {
          toolsEffectiveCache.delete(key);
          toolsEffectiveCache.set(key, { value, createdAtMs: Date.now() });
          pruneMapToMaxSize(toolsEffectiveCache, TOOLS_EFFECTIVE_CACHE_LIMIT);
          const durationMs = Date.now() - startedAt;
          if (durationMs >= TOOLS_EFFECTIVE_SLOW_LOG_MS) {
            logDebug(
              `tools-effective: refresh durationMs=${durationMs} agent=${context.agentId} session=${context.sessionKey} tools=${value.groups.reduce((sum, group) => sum + group.tools.length, 0)}`,
            );
          }
          resolve(value);
        })
        .catch((err: unknown) => reject(toErrorObject(err, "Non-Error rejection")))
        .finally(() => toolsEffectiveInflight.delete(key));
    });
  });
  toolsEffectiveInflight.set(key, task);
  return task;
}

async function resolveCachedBaseToolsEffective(
  context: TrustedToolsEffectiveContext,
): Promise<EffectiveToolInventoryResult> {
  const key = buildToolsEffectiveCacheKey(context);
  const now = Date.now();
  const cached = toolsEffectiveCache.get(key);
  if (cached) {
    const ageMs = now - cached.createdAtMs;
    if (ageMs < TOOLS_EFFECTIVE_FRESH_TTL_MS) {
      return cached.value;
    }
    if (ageMs < TOOLS_EFFECTIVE_STALE_TTL_MS) {
      // Stale-while-revalidate keeps the tools panel responsive while a new
      // registry/config snapshot is rebuilt in the background.
      void scheduleBaseToolsEffectiveRefresh(key, context).catch((err: unknown) => {
        logWarn(`tools-effective: background refresh failed: ${String(err)}`);
      });
      return cached.value;
    }
  }
  return scheduleBaseToolsEffectiveRefresh(key, context);
}

function formatMcpServerNames(names: readonly string[]): string {
  const visible = names
    .slice(0, 3)
    .map((name) => `"${name}"`)
    .join(", ");
  return names.length > 3 ? `${visible}, and ${names.length - 3} more MCP servers` : visible;
}

const MCP_DISCOVERY_NOTICES = {
  "stale-config": {
    id: "mcp-stale-catalog",
    message: (servers: string) =>
      `MCP servers ${servers} changed since the current runtime catalog was discovered. MCP tools will appear here after the next agent run discovers them.`,
  },
  "not-listed": {
    id: "mcp-not-yet-listed",
    message: (servers: string) =>
      `MCP servers ${servers} are connected but have not finished listing tools yet. MCP tools will appear here after the session discovers them.`,
  },
  "not-connected": {
    id: "mcp-not-yet-connected",
    message: (servers: string) =>
      `MCP servers ${servers} are configured but not connected for this session yet. MCP tools will appear here after an agent run discovers them.`,
  },
};

function maybeAppendMcpNotice(
  base: EffectiveToolInventoryResult,
  mcpServerNames: string[],
  reason: keyof typeof MCP_DISCOVERY_NOTICES,
): EffectiveToolInventoryResult {
  if (mcpServerNames.length === 0) {
    return base;
  }
  const servers = mcpServerNames.toSorted((a, b) => a.localeCompare(b));
  const notice = MCP_DISCOVERY_NOTICES[reason];
  return {
    ...base,
    notices: [
      ...(base.notices ?? []),
      {
        id: notice.id,
        severity: "info",
        message: notice.message(formatMcpServerNames(servers)),
        servers,
      },
    ],
  };
}

async function resolveBaseToolsEffectiveInventory(
  context: TrustedToolsEffectiveContext,
): Promise<EffectiveToolInventoryResult> {
  const agentDir = resolveAgentDir(context.cfg, context.agentId);
  const acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
    ...context,
    agentDir,
  });
  try {
    return await acquired.run((runtimeModelContext) =>
      resolveEffectiveToolInventory({
        conversationCapabilityProfile: context.capabilityProfile,
        cfg: context.cfg,
        agentId: context.agentId,
        agentDir,
        sessionKey: context.sessionKey,
        sessionId: context.sessionId,
        workspaceDir: context.workspaceDir,
        messageProvider: context.messageProvider,
        modelProvider: context.modelProvider,
        modelId: context.modelId,
        modelApi: runtimeModelContext.modelApi,
        runtimeModel: runtimeModelContext.runtimeModel,
        currentChannelId: context.currentChannelId,
        currentThreadTs: context.currentThreadTs,
        accountId: context.accountId,
        groupId: context.groupId,
        groupChannel: context.groupChannel,
        groupSpace: context.groupSpace,
        replyToMode: context.replyToMode,
        webSearchEnabled: context.toolOverrides?.webSearch,
      }),
    );
  } finally {
    await acquired[Symbol.asyncDispose]();
  }
}

async function resolveReadOnlyToolsEffectiveInventory(
  context: TrustedToolsEffectiveContext,
): Promise<EffectiveToolInventoryResult> {
  const base = await resolveCachedBaseToolsEffective(context);
  const harness = context.agentHarnessId
    ? getRegisteredAgentHarness(context.agentHarnessId)?.harness
    : undefined;
  if (harness?.loadMcpToolCatalog) {
    const mcpConfig = resolveCachedSessionMcpConfigSummary({
      context,
      workspaceDir: context.workspaceDir,
    });
    if (mcpConfig.serverNames.length === 0) {
      return base;
    }
    try {
      const catalog = await harness.loadMcpToolCatalog({
        config: context.cfg,
        agentId: context.agentId,
        sessionId: context.sessionId,
        sessionKey: context.sessionKey,
        workspaceDir: context.workspaceDir,
        mcpServerNames: mcpConfig.serverNames,
        toolOverrides: context.toolOverrides,
      });
      if (catalog) {
        return await projectMcpCatalog({
          base,
          catalog,
          context,
          workspaceDir: context.workspaceDir,
        });
      }
    } catch (error) {
      logWarn(
        `tools-effective: ${context.agentHarnessId} MCP catalog failed for session ${context.sessionKey}: ${String(error)}`,
      );
    }
    // A native owner has a distinct MCP runtime. Never substitute an in-process
    // catalog under the same OpenClaw session identity when its catalog is unavailable.
    return maybeAppendMcpNotice(base, mcpConfig.serverNames, "not-connected");
  }
  // UI panel loads call `tools.effective`, so this path must not create MCP
  // runtimes, connect transports, or issue tools/list. It only projects an
  // already-warm core session catalog. Native harnesses opt into their own
  // catalog read above because they own a separate per-thread runtime.
  const runtime = peekSessionMcpRuntime({
    sessionId: context.sessionId,
    sessionKey: context.sessionKey,
  });
  // Runtime workspaces may be sandbox copies. Compare against the same
  // workspace-derived MCP summary that created the runtime, or warm sandbox
  // catalogs look stale forever.
  const mcpConfig = resolveCachedSessionMcpConfigSummary({
    context,
    workspaceDir: runtime?.workspaceDir ?? context.workspaceDir,
  });
  if (mcpConfig.serverNames.length === 0) {
    return base;
  }
  if (!runtime) {
    return maybeAppendMcpNotice(base, mcpConfig.serverNames, "not-connected");
  }
  if (runtime.configFingerprint !== mcpConfig.fingerprint) {
    return maybeAppendMcpNotice(base, mcpConfig.serverNames, "stale-config");
  }
  // Cached catalog only; a missing catalog is a notice, not a discovery trigger.
  const catalog = runtime.peekCatalog();
  if (!catalog) {
    return maybeAppendMcpNotice(base, mcpConfig.serverNames, "not-listed");
  }
  return await projectMcpCatalog({
    base,
    catalog,
    context,
    workspaceDir: runtime.workspaceDir,
  });
}

async function projectMcpCatalog(params: {
  base: EffectiveToolInventoryResult;
  catalog: Parameters<typeof buildBundleMcpToolsFromCatalog>[0]["catalog"];
  context: TrustedToolsEffectiveContext;
  workspaceDir: string;
}): Promise<EffectiveToolInventoryResult> {
  const catalogNotices = (params.catalog.diagnostics ?? []).map(
    (diagnostic): EffectiveToolInventoryNotice => ({
      id: `mcp-server-diagnostic:${diagnostic.serverName}`,
      severity: "warning",
      message: `MCP server "${diagnostic.serverName}": ${diagnostic.message}`,
      servers: [diagnostic.serverName],
    }),
  );
  const base =
    catalogNotices.length > 0
      ? { ...params.base, notices: [...(params.base.notices ?? []), ...catalogNotices] }
      : params.base;
  const projectedMcpTools = buildBundleMcpToolsFromCatalog({
    catalog: params.catalog,
    reservedToolNames: params.base.groups.flatMap((group) => group.tools.map((tool) => tool.id)),
    includeSessionDenied: true,
  });
  const filteredMcpTools = applyFinalEffectiveToolPolicy({
    bundledTools: projectedMcpTools,
    config: params.context.cfg,
    conversationCapabilityProfile: params.context.capabilityProfile,
    warn: logWarn,
  });
  if (filteredMcpTools.length === 0) {
    return base;
  }
  const acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
    ...params.context,
    agentDir: resolveAgentDir(params.context.cfg, params.context.agentId),
    workspaceDir: params.workspaceDir,
  });
  try {
    return acquired.run((runtimeModelContext) => {
      const mcpInventory = buildEffectiveToolInventory(
        {
          tools: filteredMcpTools,
          cfg: params.context.cfg,
          workspaceDir: params.workspaceDir,
          modelProvider: params.context.modelProvider,
          modelId: params.context.modelId,
          modelApi: runtimeModelContext.modelApi,
          runtimeModel: runtimeModelContext.runtimeModel,
        },
        {
          allowProviderRuntimePluginLoad: false,
          rawDescriptionFallback: "summary",
          diagnosticOwner: () => ` from plugin "${BUNDLE_MCP_PLUGIN_ID}"`,
          createToolProjection: () => (tool) => {
            const mcp = getPluginToolMeta(tool)?.mcp;
            return {
              source: "mcp",
              pluginId: BUNDLE_MCP_PLUGIN_ID,
              ...(mcp
                ? {
                    mcpServer: mcp.serverName,
                    mcpToolName: mcp.toolName,
                    ...(mcp.deniedBySession ? { deniedBySession: true } : {}),
                  }
                : {}),
            };
          },
        },
      );
      const notices = [...(base.notices ?? []), ...mcpInventory.notices];
      if (mcpInventory.entries.length === 0) {
        return notices.length > 0 ? { ...base, notices } : base;
      }
      return {
        ...base,
        ...(notices.length > 0 ? { notices } : {}),
        groups: [...params.base.groups, ...buildEffectiveToolInventoryGroups(mcpInventory.entries)],
      };
    });
  } finally {
    await acquired[Symbol.asyncDispose]();
  }
}

async function resolveTrustedToolsEffectiveContext(
  params: {
    sessionKey: string;
    requestedAgentId?: string;
    respond: RespondFn;
    context: GatewayRequestContext;
  },
  loaded: Pick<GatewaySessionEntryRead, "entry" | "canonicalKey" | "cfg">,
) {
  // The effective tools request is read-only but security-sensitive. Derive
  // routing/account/model context from the persisted session, not client params.
  if (!loaded.entry) {
    respondError(
      params.respond,
      ErrorCodes.INVALID_REQUEST,
      `unknown session key "${params.sessionKey}"`,
    );
    return null;
  }

  const canonicalKey = loaded.canonicalKey ?? params.sessionKey;
  const sessionAgentId = resolveSessionAgentId({
    sessionKey: canonicalKey,
    config: loaded.cfg,
    ...(params.requestedAgentId ? { agentId: params.requestedAgentId } : {}),
  });
  if (params.requestedAgentId && params.requestedAgentId !== sessionAgentId) {
    respondError(
      params.respond,
      ErrorCodes.INVALID_REQUEST,
      `agent id "${params.requestedAgentId}" does not match session agent "${sessionAgentId}"`,
    );
    return null;
  }

  const delivery = deliveryContextFromSession(loaded.entry);
  const origin = sessionDeliveryOrigin(loaded.entry);
  const resolvedModel = resolveSessionModelRef(loaded.cfg, loaded.entry, sessionAgentId);
  const workspaceDir =
    normalizeOptionalString(loaded.entry.spawnedWorkspaceDir) ??
    resolveAgentWorkspaceDir(loaded.cfg, sessionAgentId);
  const context = {
    cfg: loaded.cfg,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    sessionId: loaded.entry.sessionId,
    workspaceDir,
    runtimeConfigCacheKey: resolveRuntimeConfigCacheKey(loaded.cfg),
    pluginRegistryVersion: getActivePluginRegistryVersion(),
    channelRegistryVersion: getActivePluginChannelRegistryVersion(),
    nodePluginToolsVersion: getConnectedNodePluginToolsVersion(),
    modelProvider: resolvedModel.provider,
    modelId: resolvedModel.model,
    messageProvider: delivery?.channel ?? origin?.provider,
    accountId: delivery?.accountId ?? origin?.accountId,
    currentChannelId: delivery?.to,
    currentThreadTs:
      delivery?.threadId != null
        ? stringifyRouteThreadId(delivery.threadId)
        : origin?.threadId != null
          ? stringifyRouteThreadId(origin.threadId)
          : undefined,
    groupId: loaded.entry.groupId,
    groupChannel: loaded.entry.groupChannel,
    groupSpace: loaded.entry.space,
    spawnedBy: normalizeOptionalString(loaded.entry.spawnedBy),
    agentHarnessId: normalizeOptionalString(loaded.entry.agentHarnessId),
    toolOverrides: loaded.entry.toolOverrides,
    replyToMode: resolveReplyToMode(
      loaded.cfg,
      delivery?.channel ?? origin?.provider,
      delivery?.accountId ?? origin?.accountId,
      loaded.entry.chatType ?? origin?.chatType,
    ),
  };
  return {
    ...context,
    capabilityProfile: await prepareConversationCapabilityProfile({
      config: context.cfg,
      sessionKey: context.sessionKey,
      preparedSessionEntry: { sessionKey: canonicalKey, entry: loaded.entry },
      sandboxToolPolicy: await resolveSessionToolPreviewSandboxPolicy({
        cfg: context.cfg,
        agentId: context.agentId,
        sessionKey: canonicalKey,
        sessionEntry: loaded.entry,
        context: params.context,
      }),
      agentId: context.agentId,
      modelProvider: context.modelProvider,
      modelId: context.modelId,
      messageProvider: context.messageProvider,
      agentAccountId: context.accountId,
      groupId: context.groupId,
      groupChannel: context.groupChannel,
      groupSpace: context.groupSpace,
      spawnedBy: context.spawnedBy,
    }),
  };
}

export const toolsEffectiveHandlers: GatewayRequestHandlers = {
  "tools.effective": defineValidatedGatewayHandler(
    "tools.effective",
    validateToolsEffectiveParams,
    async (options) => {
      const { params, respond, context } = options;
      const cfg = context.getRuntimeConfig();
      const knownAgents = listAgentIds(cfg);
      const requestedAgentId = normalizeOptionalString(params.agentId);
      if (requestedAgentId && !knownAgents.includes(requestedAgentId)) {
        respondError(respond, ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`);
        return;
      }
      const sessionOwner = resolveRequestedSessionAgentId(cfg, params.sessionKey, requestedAgentId);
      if (!sessionOwner.ok) {
        respond(false, undefined, sessionOwner.error);
        return;
      }
      const authority = readGatewayRequestMutationAuthority(options);
      const sessionOnly = authority.sessionScope === "operator.sessions.read";
      const consume = async (
        loaded: Pick<GatewaySessionEntryRead, "entry" | "canonicalKey" | "cfg">,
        assertSourceCurrent: () => void,
      ) => {
        const trustedContext = await resolveTrustedToolsEffectiveContext(
          {
            sessionKey: params.sessionKey,
            requestedAgentId: sessionOwner.agentId,
            respond,
            context,
          },
          loaded,
        );
        if (!trustedContext) {
          return;
        }
        const inventory = await resolveReadOnlyToolsEffectiveInventory(trustedContext);
        authority.assertCurrent();
        assertSourceCurrent();
        respond(true, sessionOnly ? projectSessionToolPreview(inventory) : inventory, undefined);
      };
      let scopedRead: Awaited<ReturnType<typeof retainSessionScopedRead>>;
      try {
        scopedRead = await retainSessionScopedRead(
          options,
          params.sessionKey,
          sessionOwner.agentId,
          { requireMaterialized: true },
        );
        if (scopedRead) {
          await consume(scopedRead.prepared, scopedRead.assertCurrent);
          return;
        }
        const memory = captureSessionEntryMetadataRead(
          {
            agentId: sessionOwner.agentId,
            sessionKey: params.sessionKey,
          },
          authority.assertCurrent,
        );
        if (memory) {
          const entry = memory.readCurrent();
          await consume({ cfg, canonicalKey: params.sessionKey, entry }, () => {
            const current = memory.readCurrent();
            if (
              current?.sessionId !== entry?.sessionId ||
              current?.lifecycleRevision !== entry?.lifecycleRevision
            ) {
              throw new Error("Session changed while resolving effective tools");
            }
          });
        } else {
          await withGatewaySessionEntryReadOnly(
            {
              cfg,
              key: params.sessionKey,
              agentId: sessionOwner.agentId,
              assertActive: authority.assertCurrent,
            },
            consume,
          );
        }
      } catch (err) {
        if (err instanceof SessionMutationAuthorizationChangedError) {
          respond(false, undefined, err.error);
          return;
        }
        if (sessionOnly) {
          logWarn(`tools-effective: preview failed: ${String(err)}`);
        }
        respondError(
          respond,
          ErrorCodes.UNAVAILABLE,
          sessionOnly
            ? "Tool preview is unavailable. Retry the request."
            : `tools.effective failed: ${String(err)}`,
        );
      } finally {
        scopedRead?.release();
      }
    },
  ),
};

export const testing = {
  resetToolsEffectiveCacheForTest() {
    toolsEffectiveCache.clear();
    toolsEffectiveInflight.clear();
    mcpConfigSummaryCache.clear();
  },
} as const;
