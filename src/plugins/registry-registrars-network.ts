import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import {
  createPluginGatewayMethodDescriptor,
  type GatewayMethodProfileAccess,
} from "../gateway/methods/descriptor.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayRequestHandler, RespondFn } from "../gateway/server-methods/types.js";
import { normalizePluginGatewayMethodScope } from "../shared/gateway-method-policy.js";
import { normalizeRegisteredChannelPlugin } from "./channel-validation.js";
import { normalizePluginHttpPath } from "./http-path.js";
import { findPluginHttpRouteRegistrationConflicts } from "./http-route-overlap.js";
import { getPluginHttpRouteViews, replacePluginHttpRoutes } from "./http-route-owner.js";
import { wrapCurrentPluginInstance } from "./plugin-instance-scope.js";
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
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import type { SessionCatalogProvider } from "./session-catalog.js";
import type {
  OpenClawPluginChannelRegistration,
  OpenClawPluginHostedMediaResolver,
  OpenClawPluginHttpRouteParams,
  OpenClawPluginMcpServerConnectionResolver,
  OpenClawPluginMcpServerRequestHeaderProvider,
  PluginRegistrationMode,
} from "./types.js";

const GATEWAY_METHOD_DISPATCH_CONTRACT = "authenticated-request";

function adaptPluginGatewayMethodHandler(
  handler: GatewayRequestHandler,
  mayDispatch: boolean,
): GatewayRequestHandler {
  return async (opts) => {
    let responded = false;
    const respond: RespondFn = (ok, payload, error, meta) => {
      responded = true;
      opts.respond(ok, payload, error, meta);
    };
    const scope = getPluginRuntimeGatewayRequestScope();
    const invoke = () => handler({ ...opts, respond });
    // A declared authenticated-request contract composes RPCs with the exact
    // admitted client, never a synthetic identity or inherited unrelated grant.
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
  };
}

export function createNetworkRegistrars(state: PluginRegistryState) {
  const {
    registry,
    createRegistration,
    coreGatewayMethods,
    pluginsWithChannelRegistrationConflict,
    pushDiagnostic,
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
    const normalizedProvider = { ...provider, id, label };
    registry.sessionCatalogs.push(
      createRegistration(record, {
        provider:
          state.getNativeCatalogGate(record)?.catalog(normalizedProvider) ?? normalizedProvider,
      }),
    );
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

  const registerHostedMediaResolver = (
    record: PluginRecord,
    resolver: OpenClawPluginHostedMediaResolver,
  ) => {
    if (typeof resolver !== "function") {
      reportRegistrationError(record, "hosted media resolver registration missing resolver");
      return;
    }
    registry.hostedMediaResolvers.push(
      createRegistration(record, {
        resolver,
      }),
    );
  };

  const hasMcpServerOwnerConflict = (
    record: PluginRecord,
    serverName: string,
    kind: "connection resolver" | "request header provider",
  ) => {
    const owner =
      registry.mcpServerConnectionResolvers.find(
        (entry) => entry.resolver.serverName === serverName,
      ) ??
      registry.mcpServerRequestHeaderProviders.find(
        (entry) => entry.provider.serverName === serverName,
      );
    if (owner && owner.pluginId !== record.id) {
      // Both seams share ownership: another plugin must not attach credentials
      // to an existing owner's endpoint or redirect an existing owner's headers.
      reportRegistrationError(
        record,
        `MCP server ${kind} for "${serverName}" rejected: already registered by plugin "${owner.pluginId}"`,
      );
      return true;
    }
    return false;
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
    if (hasMcpServerOwnerConflict(record, serverName, "connection resolver")) {
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
      registry.mcpServerConnectionResolvers[existingIndex] = registration;
      return;
    }
    registry.mcpServerConnectionResolvers.push(registration);
  };

  const registerMcpServerRequestHeaderProvider = (
    record: PluginRecord,
    provider: OpenClawPluginMcpServerRequestHeaderProvider,
  ) => {
    const serverName = normalizeOptionalString(provider?.serverName);
    if (!serverName || typeof provider.resolve !== "function") {
      reportRegistrationError(
        record,
        "MCP server request header provider registration missing serverName or resolve",
      );
      return;
    }
    if (hasMcpServerOwnerConflict(record, serverName, "request header provider")) {
      return;
    }
    const existingIndex = registry.mcpServerRequestHeaderProviders.findIndex(
      (entry) => entry.provider.serverName === serverName,
    );
    const registration = createRegistration(record, {
      provider: { serverName, resolve: provider.resolve },
    });
    if (existingIndex >= 0) {
      registry.mcpServerRequestHeaderProviders[existingIndex] = registration;
      return;
    }
    registry.mcpServerRequestHeaderProviders.push(registration);
  };

  const registerChannel = (
    record: PluginRecord,
    registration: OpenClawPluginChannelRegistration | ChannelPlugin,
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
    const normalized =
      typeof (registration as OpenClawPluginChannelRegistration).plugin === "object"
        ? (registration as OpenClawPluginChannelRegistration)
        : { plugin: registration as ChannelPlugin };
    const plugin = normalizeRegisteredChannelPlugin({
      pluginId: record.id,
      source: record.source,
      plugin: normalized.plugin,
      pushDiagnostic,
    });
    if (!plugin) {
      return;
    }
    const id = plugin.id;
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
    registerHostedMediaResolver,
    registerMcpServerConnectionResolver,
    registerMcpServerRequestHeaderProvider,
    registerChannel,
  };
}
