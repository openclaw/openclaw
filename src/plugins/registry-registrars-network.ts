import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/schema/error-codes.js";
import { listChatChannels } from "../channels/chat-meta.js";
import { normalizeChannelMeta } from "../channels/plugins/meta-normalization.js";
import type { AnyChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelMeta } from "../channels/plugins/types.public.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
import {
  createPluginGatewayMethodDescriptor,
  type GatewayMethodProfileAccess,
} from "../gateway/methods/descriptor.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayRequestHandler, RespondFn } from "../gateway/server-methods/types.js";
import { normalizePluginGatewayMethodScope } from "../shared/gateway-method-policy.js";
import { normalizePluginHttpPath } from "./http-path.js";
import { findPluginHttpRouteRegistrationConflicts } from "./http-route-overlap.js";
import { getPluginHttpRouteViews, replacePluginHttpRoutes } from "./http-route-owner.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalChannelCatalogEntries,
} from "./official-external-plugin-catalog.js";
import { getPluginInstance, wrapCurrentPluginInstance } from "./plugin-instance-scope.js";
import { capturePluginLifecycleAuthority, getPluginRecordRegistry } from "./registry-lifecycle.js";
import {
  resolvePluginRegistrationCapabilities,
  type PluginRegistryState,
} from "./registry-state.js";
import type {
  PluginChannelRegistration,
  PluginHttpRouteRegistration,
  PluginRecord,
} from "./registry-types.js";
import {
  PluginCapabilityRemovedError,
  removedPluginCapabilityDescriptor,
} from "./removed-capability-error.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import type { SessionCatalogProvider } from "./session-catalog.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginHttpRouteParams,
  OpenClawPluginMcpServerConnectionResolver,
  PluginRegistrationMode,
} from "./types.js";

const GATEWAY_METHOD_DISPATCH_CONTRACT = "authenticated-request";
const CHANNEL_CAPABILITY_CHAT_TYPES = new Set(["direct", "group", "channel", "thread"]);
const REMOVED_SESSION_CONTEXT_CAPABILITIES = Object.fromEntries(
  ["chatAbortControllers", "chatQueuedTurns"].map((name) => [
    name,
    removedPluginCapabilityDescriptor(
      `context.${name}`,
      'Use dispatchGatewayMethod from openclaw/plugin-sdk/gateway-method-runtime with chat.send, chat.abort, sessions.abort, or agent.wait; declare contracts.gatewayMethodDispatch: ["authenticated-request"].',
    ),
  ]),
);

function resolveKnownChannelMeta(id: string): Partial<ChannelMeta> | undefined {
  return (
    listChatChannels().find((meta) => meta?.id === id) ??
    resolveGeneratedBundledChannelMeta(id) ??
    resolveOfficialExternalChannelMeta(id)
  );
}

function resolveOfficialExternalChannelMeta(id: string): Partial<ChannelMeta> | undefined {
  const normalizedId = id.toLowerCase();
  const channel = listOfficialExternalChannelCatalogEntries()
    .map((entry) => getOfficialExternalPluginCatalogManifest(entry)?.channel)
    .find((candidate) => candidate?.id?.trim().toLowerCase() === normalizedId);
  return channel?.aliases?.length ? { aliases: channel.aliases } : undefined;
}

function resolveGeneratedBundledChannelMeta(id: string): ChannelMeta | undefined {
  const channel = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
    (entry) => entry.channelId === id && entry.configurable !== false,
  );
  const label = normalizeOptionalString(channel?.label);
  if (!channel || !label) {
    return undefined;
  }
  return {
    id,
    label,
    selectionLabel: label,
    docsPath: `/channels/${id}`,
    blurb: normalizeOptionalString(channel.description) ?? "",
  };
}

function collectMissingChannelMetaFields(meta?: Partial<ChannelMeta> | null): string[] {
  const missing: string[] = (["label", "selectionLabel", "docsPath"] as const).filter(
    (key) => !normalizeOptionalString(meta?.[key]),
  );
  if (typeof meta?.blurb !== "string") {
    missing.push("blurb");
  }
  return missing;
}

function adaptPluginGatewayMethodHandler(
  handler: GatewayRequestHandler,
  mayDispatch: boolean,
): GatewayRequestHandler {
  return async (opts) => {
    // Preserve the real context identity; these accessors expose no mutable state.
    Object.defineProperties(opts.context, REMOVED_SESSION_CONTEXT_CAPABILITIES);
    let responded = false;
    const respond: RespondFn = (ok, payload, error, meta) => {
      responded = true;
      opts.respond(ok, payload, error, meta);
    };
    const scope = getPluginRuntimeGatewayRequestScope();
    const invoke = () => handler({ ...opts, respond });
    // A declared authenticated-request contract composes RPCs with the exact
    // admitted client, never a synthetic identity or inherited unrelated grant.
    try {
      const result = (
        scope
          ? await withPluginRuntimeGatewayRequestScope(
              { ...scope, gatewayMethodDispatchAllowed: mayDispatch && scope.client != null },
              invoke,
            )
          : await invoke()
      ) as unknown;
      if (!responded && result !== undefined) {
        respond(true, result);
      }
    } catch (error) {
      if (!(error instanceof PluginCapabilityRemovedError) || responded) {
        throw error;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
          retryable: false,
          details: { code: error.code, capability: error.capability },
        }),
      );
    }
  };
}

export function createNetworkRegistrars(state: PluginRegistryState) {
  const {
    registry,
    createRegistration,
    coreGatewayMethods,
    pluginsWithChannelRegistrationConflict,
    reportRegistrationError,
    reportRegistrationWarning,
  } = state;
  let reportedLegacyCatalogSkip = false;

  const registerGatewayMethod = (
    record: PluginRecord,
    method: string,
    handler: GatewayRequestHandler,
    opts?: {
      scope?: OperatorScope;
      profileAccess?: GatewayMethodProfileAccess;
      sessionAccess?: import("../gateway/methods/descriptor.js").GatewayMethodSessionAccess;
      shareKey?: import("../gateway/methods/descriptor.js").GatewayReadSharing["shareKey"];
      shareInvalidationEvents?: readonly string[];
      shareMaxAgeMs?: number;
    },
  ) => {
    const trimmed = method.trim();
    if (!trimmed) {
      return;
    }
    if (coreGatewayMethods.has(trimmed) || registry.gatewayHandlers[trimmed]) {
      reportRegistrationError(record, `gateway method already registered: ${trimmed}`);
      return;
    }
    const wrappedHandler = adaptPluginGatewayMethodHandler(
      handler,
      canDispatchGatewayMethods(record),
    );
    registry.gatewayHandlers[trimmed] = wrappedHandler;
    const normalizedScope = normalizePluginGatewayMethodScope(trimmed, opts?.scope);
    if (normalizedScope.coercedToReservedAdmin) {
      reportRegistrationWarning(
        record,
        `gateway method scope coerced to operator.admin for reserved core namespace: ${trimmed}`,
      );
    }
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: record.id,
        name: trimmed,
        handler: wrappedHandler,
        scope: normalizedScope.scope,
        ...(opts?.profileAccess ? { profileAccess: opts.profileAccess } : {}),
        ...(opts?.sessionAccess ? { sessionAccess: opts.sessionAccess } : {}),
        ...(opts?.shareKey
          ? {
              shareKey: (caller, params) =>
                capturePluginLifecycleAuthority(getPluginRecordRegistry(registry, record), record, {
                  scopedRuntime: true,
                })?.() === true
                  ? opts.shareKey!(caller, params)
                  : null,
              shareInvalidationEvents: opts.shareInvalidationEvents,
              shareMaxAgeMs: opts.shareMaxAgeMs,
            }
          : {}),
      }),
    );
  };

  const registerSessionCatalog = (record: PluginRecord, provider: SessionCatalogProvider) => {
    const id = provider.id.trim();
    const label = provider.label.trim();
    if (!id || !label) {
      reportRegistrationError(record, "session catalog requires non-empty id and label");
      return;
    }
    if (!state.allowProcessHomeSessionCatalogs && provider.supportsProcessHomeIsolation !== true) {
      if (!reportedLegacyCatalogSkip) {
        reportedLegacyCatalogSkip = true;
        reportRegistrationWarning(
          record,
          "external session catalog skipped in isolated state: provider must declare supportsProcessHomeIsolation",
        );
      }
      return;
    }
    const existing = registry.sessionCatalogs.find((entry) => entry.provider.id === id);
    if (existing) {
      reportRegistrationError(
        record,
        `session catalog already registered: ${id} (${existing.pluginId})`,
      );
      return;
    }
    if (provider.continueSession) {
      getPluginInstance(record)?.admitFactory(provider.continueSession, ["afterConversationBound"]);
    }
    const normalizedProvider = { ...provider, id, label };
    const catalog =
      state.getNativeCatalogGate(record)?.catalog(normalizedProvider) ?? normalizedProvider;
    if (catalog.continueSession) {
      getPluginInstance(record)?.admitFactory(catalog.continueSession, ["afterConversationBound"]);
    }
    registry.sessionCatalogs.push(createRegistration(record, { provider: catalog }));
  };

  const describeHttpRouteOwner = (entry: PluginHttpRouteRegistration): string => {
    const plugin = normalizeOptionalString(entry.pluginId) || "unknown-plugin";
    const source = normalizeOptionalString(entry.source) || "unknown-source";
    return `${plugin} (${source})`;
  };

  const canDispatchGatewayMethods = (record: PluginRecord): boolean =>
    (record.contracts?.gatewayMethodDispatch ?? []).includes(GATEWAY_METHOD_DISPATCH_CONTRACT);

  const registerHttpRoute = (record: PluginRecord, params: OpenClawPluginHttpRouteParams) => {
    const normalizedPath = normalizePluginHttpPath(params.path);
    if (!normalizedPath) {
      reportRegistrationWarning(record, "http route registration missing path");
      return;
    }
    if (params.auth !== "gateway" && params.auth !== "plugin") {
      reportRegistrationError(
        record,
        `http route registration missing or invalid auth: ${normalizedPath}`,
      );
      return;
    }
    const match = params.match ?? "exact";
    const { authOverlap, canonicalMatches } = findPluginHttpRouteRegistrationConflicts(
      [...new Set(getPluginHttpRouteViews(registry, record.id).flatMap((view) => view.httpRoutes))],
      {
        path: normalizedPath,
        match,
        auth: params.auth,
      },
    );
    if (authOverlap) {
      reportRegistrationError(
        record,
        `http route overlap rejected: ${normalizedPath} (${match}, ${params.auth}) ` +
          `overlaps ${authOverlap.path} (${authOverlap.match}, ${authOverlap.auth}) ` +
          `owned by ${describeHttpRouteOwner(authOverlap)}`,
      );
      return;
    }
    const registration = {
      pluginId: record.id,
      path: normalizedPath,
      handler: params.handler,
      ...(params.handleUpgrade ? { handleUpgrade: params.handleUpgrade } : {}),
      auth: params.auth,
      match,
      ...(params.gatewayRuntimeScopeSurface
        ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
        : {}),
      ...(canDispatchGatewayMethods(record) ? { gatewayMethodDispatchAllowed: true } : {}),
      ...(params.nodeCapability ? { nodeCapability: { ...params.nodeCapability } } : {}),
      source: record.source,
    } satisfies PluginHttpRouteRegistration;
    const foreignOwner = canonicalMatches.find((route) => route.pluginId !== record.id);
    if (foreignOwner) {
      reportRegistrationError(
        record,
        params.replaceExisting
          ? `http route replacement rejected: ${normalizedPath} (${match}) owned by ${describeHttpRouteOwner(foreignOwner)}`
          : `http route already registered: ${normalizedPath} (${match}) by ${describeHttpRouteOwner(foreignOwner)}`,
      );
      return;
    }
    if (!canonicalMatches.length) {
      record.httpRoutes += 1;
    }
    replacePluginHttpRoutes(registry, registration, canonicalMatches, true);
  };

  const registerMcpServerConnectionResolver = (
    record: PluginRecord,
    resolver: OpenClawPluginMcpServerConnectionResolver,
  ) => {
    const serverName = normalizeOptionalString(resolver?.serverName);
    if (!serverName || typeof resolver.resolve !== "function") {
      reportRegistrationError(
        record,
        "MCP server connection resolver registration missing serverName or resolve",
      );
      return;
    }
    const existingIndex = registry.mcpServerConnectionResolvers.findIndex(
      (entry) => entry.resolver.serverName === serverName,
    );
    const registration = createRegistration(record, {
      resolver: {
        serverName,
        resolve: resolver.resolve,
      },
    });
    if (existingIndex >= 0) {
      const existing = registry.mcpServerConnectionResolvers[existingIndex];
      // Resolver ownership is an authorization boundary: connection identity
      // must not depend on plugin load order. First registration wins; a
      // duplicate from another plugin is rejected, not silently replaced.
      if (existing && existing.pluginId !== record.id) {
        reportRegistrationError(
          record,
          `MCP server connection resolver for "${serverName}" rejected: already registered by plugin "${existing.pluginId}"`,
        );
        return;
      }
      registry.mcpServerConnectionResolvers[existingIndex] = registration;
      return;
    }
    registry.mcpServerConnectionResolvers.push(registration);
  };

  const registerChannel = (
    record: PluginRecord,
    registration: Parameters<OpenClawPluginApi["registerChannel"]>[0],
    mode: PluginRegistrationMode = "full",
    resolveChannelRuntime?: PluginChannelRegistration["resolveChannelRuntime"],
  ) => {
    if (record.origin === "workspace" && !record.enabled) {
      reportRegistrationWarning(
        record,
        `channel registration rejected for disabled workspace plugin: ${record.id}`,
      );
      return;
    }
    const registrationCapabilities = resolvePluginRegistrationCapabilities(mode);
    const pluginRegistration = "plugin" in registration ? registration.plugin : registration;
    const id =
      normalizeOptionalString(pluginRegistration?.id) ??
      normalizeStringifiedOptionalString(pluginRegistration?.id) ??
      "";
    if (!id) {
      reportRegistrationError(record, "channel registration missing id");
      return;
    }
    const chatTypes = pluginRegistration.capabilities?.chatTypes;
    if (
      !Array.isArray(chatTypes) ||
      chatTypes.length === 0 ||
      chatTypes.some((chatType) => !CHANNEL_CAPABILITY_CHAT_TYPES.has(chatType))
    ) {
      reportRegistrationError(
        record,
        `channel "${id}" registration missing or invalid required capabilities.chatTypes`,
      );
      return;
    }
    if (
      typeof pluginRegistration.config?.listAccountIds !== "function" ||
      typeof pluginRegistration.config?.resolveAccount !== "function"
    ) {
      reportRegistrationError(
        record,
        `channel "${id}" registration missing required config helpers`,
      );
      return;
    }
    const rawMeta: Partial<ChannelMeta> | undefined = pluginRegistration.meta;
    const rawMetaId = normalizeOptionalString(rawMeta?.id);
    if (rawMetaId && rawMetaId !== id) {
      reportRegistrationWarning(
        record,
        `channel "${id}" meta.id mismatch ("${rawMetaId}"); using registered channel id`,
      );
    }
    const missingFields = collectMissingChannelMetaFields(rawMeta);
    if (missingFields.length > 0) {
      reportRegistrationWarning(
        record,
        `channel "${id}" registered incomplete metadata; filled missing ${missingFields.join(", ")}`,
      );
    }
    const plugin: AnyChannelPlugin = {
      ...pluginRegistration,
      id,
      meta: normalizeChannelMeta({ id, meta: rawMeta, existing: resolveKnownChannelMeta(id) }),
    };
    const existingRuntime = registrationCapabilities.runtimeChannel
      ? registry.channels.find((entry) => entry.plugin.id === id)
      : undefined;
    const existingSetup = registry.channelSetups.find((entry) => entry.plugin.id === id);
    const existing = existingRuntime ?? existingSetup;
    if (existing && existing.pluginId !== record.id) {
      reportRegistrationError(
        record,
        `${existingRuntime ? "channel" : "channel setup"} already registered: ${id} (${existing.pluginId})`,
      );
      pluginsWithChannelRegistrationConflict.add(record.id);
      return;
    }
    const agentTools = plugin.agentTools;
    if (agentTools) {
      plugin.agentTools = typeof agentTools === "function" ? agentTools : () => agentTools;
      getPluginInstance(record)?.admitFactory(plugin.agentTools, "tool");
    }
    const metadata = {
      // Normalization copied the input; teardown must retain its registration owner.
      plugin: wrapCurrentPluginInstance(plugin),
      pluginName: record.name,
      origin: record.origin,
      source: record.source,
      rootDir: record.rootDir,
    };
    // Bind the selected registration; unchanged instances can move to a new registry.
    const captureReadAuthority = () => {
      const currentRegistry = getPluginRecordRegistry(registry, record);
      const entry = currentRegistry.channels.find((candidate) => candidate.plugin.id === id);
      const ownerCurrent = capturePluginLifecycleAuthority(currentRegistry, record, {
        scopedRuntime: true,
      });
      const isCurrent = () =>
        ownerCurrent?.() === true &&
        (record.origin === "bundled" || record.trustedOfficialInstall === true) &&
        entry !== undefined &&
        getPluginRecordRegistry(registry, record).channels.includes(entry) &&
        entry.pluginId === record.id &&
        entry.plugin === metadata.plugin &&
        entry.captureReadAuthority === captureReadAuthority;
      return isCurrent() ? isCurrent : undefined;
    };
    if (existing) {
      if (existingRuntime) {
        Object.assign(existingRuntime, metadata, { resolveChannelRuntime, captureReadAuthority });
      }
      if (existingSetup) {
        Object.assign(existingSetup, metadata, { enabled: record.enabled });
      }
      return;
    }
    if (!record.channelIds.includes(id)) {
      record.channelIds.push(id);
    }
    registry.channelSetups.push({ ...metadata, pluginId: record.id, enabled: record.enabled });
    if (registrationCapabilities.runtimeChannel) {
      registry.channels.push({
        ...metadata,
        pluginId: record.id,
        resolveChannelRuntime,
        captureReadAuthority,
      });
    }
  };

  return {
    registerGatewayMethod,
    registerSessionCatalog,
    registerHttpRoute,
    registerMcpServerConnectionResolver,
    registerChannel,
  };
}
