/**
 * Channel message action discovery.
 *
 * Builds agent tool schema contributions from loaded or bundled channel action hooks.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { TSchema } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeAnyChannelId } from "../registry.js";
import { getChannelPlugin, getLoadedChannelPlugin, listChannelPlugins } from "./index.js";
import type { ChannelMessageCapability } from "./message-capabilities.js";
import {
  resolveBundledChannelMessageToolDiscoveryAdapter,
  type ChannelMessageToolDiscoveryAdapter,
} from "./message-tool-api.js";
import type {
  ChannelMessageActionDiscoveryContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "./types.public.js";

/**
 * Input used to discover channel message actions for agent tool schemas.
 */
export type ChannelMessageActionDiscoveryInput = {
  cfg?: OpenClawConfig;
  channel?: string | null;
  currentChannelProvider?: string | null;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
};

type ChannelMessageActionDiscoveryParams = ChannelMessageActionDiscoveryInput & {
  cfg: OpenClawConfig;
};

type ChannelMessageToolMediaSourceParamKeyInput = ChannelMessageActionDiscoveryParams & {
  action?: ChannelMessageActionName;
};

const loggedMessageActionErrors = new Set<string>();

/**
 * Normalizes a raw channel/provider id before consulting action discovery hooks.
 */
export function resolveMessageActionDiscoveryChannelId(raw?: string | null): string | undefined {
  return normalizeAnyChannelId(raw) ?? normalizeOptionalString(raw);
}

/**
 * Builds the context object passed to plugin message-tool discovery hooks.
 */
export function createMessageActionDiscoveryContext(
  params: ChannelMessageActionDiscoveryInput,
): ChannelMessageActionDiscoveryContext {
  const currentChannelProvider = resolveMessageActionDiscoveryChannelId(
    params.channel ?? params.currentChannelProvider,
  );
  return {
    cfg: params.cfg ?? ({} as OpenClawConfig),
    currentChannelId: params.currentChannelId,
    currentChannelProvider,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    accountId: params.accountId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    requesterSenderId: params.requesterSenderId,
    senderIsOwner: params.senderIsOwner,
  };
}

function logMessageActionError(params: {
  pluginId: string;
  operation: "describeMessageTool" | "readMessageToolDiscovery";
  field?: string;
  error: unknown;
}) {
  const message = formatErrorMessage(params.error);
  const key = `${params.pluginId}:${params.operation}:${params.field ?? ""}:${message}`;
  // Discovery runs while building tool schemas, so log each plugin/error pair
  // once and let the agent continue with the remaining channel capabilities.
  if (loggedMessageActionErrors.has(key)) {
    return;
  }
  loggedMessageActionErrors.add(key);
  const stack = params.error instanceof Error && params.error.stack ? params.error.stack : null;
  const field = params.field ? `.${params.field}` : "";
  defaultRuntime.error?.(
    `[message-action-discovery] ${params.pluginId}.actions.${params.operation}${field} failed: ${stack ?? message}`,
  );
}

function describeMessageToolSafely(params: {
  pluginId: string;
  context: ChannelMessageActionDiscoveryContext;
  describeMessageTool: NonNullable<ChannelMessageToolDiscoveryAdapter["describeMessageTool"]>;
}): ChannelMessageToolDiscovery | null {
  try {
    return params.describeMessageTool(params.context) ?? null;
  } catch (error) {
    logMessageActionError({
      pluginId: params.pluginId,
      operation: "describeMessageTool",
      error,
    });
    return null;
  }
}

function readMessageToolDiscoveryValue<T>(params: {
  pluginId: string;
  field: string;
  read: () => T;
  fallback: T;
}): T {
  try {
    return params.read();
  } catch (error) {
    logMessageActionError({
      pluginId: params.pluginId,
      operation: "readMessageToolDiscovery",
      field: params.field,
      error,
    });
    return params.fallback;
  }
}

type SchemaContributionsRead = {
  contributions: ChannelMessageToolSchemaContribution[];
  unreadable: boolean;
};

const unreadableSchemaContribution = Symbol("unreadableSchemaContribution");

/**
 * Normalizes plugin schema contributions into a list for merge callers.
 */
function normalizeToolSchemaContributions(
  pluginId: string,
  value:
    | ChannelMessageToolSchemaContribution
    | ChannelMessageToolSchemaContribution[]
    | null
    | undefined,
): SchemaContributionsRead {
  if (!value) {
    return { contributions: [], unreadable: false };
  }
  if (!Array.isArray(value)) {
    return { contributions: [value], unreadable: false };
  }
  const length = readMessageToolDiscoveryValue({
    pluginId,
    field: "schema.length",
    fallback: null,
    read: () => value.length,
  });
  if (length === null) {
    return { contributions: [], unreadable: true };
  }
  const contributions: ChannelMessageToolSchemaContribution[] = [];
  let unreadable = false;
  for (let index = 0; index < length; index += 1) {
    const contribution = readMessageToolDiscoveryValue<
      ChannelMessageToolSchemaContribution | undefined | typeof unreadableSchemaContribution
    >({
      pluginId,
      field: `schema.${index}`,
      fallback: unreadableSchemaContribution,
      read: () => value[index],
    });
    if (contribution === unreadableSchemaContribution) {
      unreadable = true;
      continue;
    }
    if (contribution) {
      contributions.push(contribution);
    }
  }
  return { contributions, unreadable };
}

type ResolvedChannelMessageActionDiscovery = {
  actions: ChannelMessageActionName[];
  capabilities: readonly ChannelMessageCapability[];
  schemaContributions: ChannelMessageToolSchemaContribution[];
  schemaContributionsUnreadable: boolean;
  mediaSourceParams: readonly string[];
};

type MessageToolMediaSourceParamMap = Partial<Record<ChannelMessageActionName, readonly string[]>>;

/**
 * Resolves media-source parameter names, optionally scoped to one action.
 */
function normalizeMessageToolMediaSourceParams(
  mediaSourceParams: ChannelMessageToolDiscovery["mediaSourceParams"],
  action?: ChannelMessageActionName,
): readonly string[] {
  if (Array.isArray(mediaSourceParams)) {
    return mediaSourceParams;
  }
  if (!mediaSourceParams || typeof mediaSourceParams !== "object") {
    return [];
  }
  const scopedMediaSourceParams = mediaSourceParams as MessageToolMediaSourceParamMap;
  if (action) {
    const scoped = scopedMediaSourceParams[action];
    return Array.isArray(scoped) ? scoped : [];
  }
  return Object.values(scopedMediaSourceParams).flatMap((scoped) =>
    Array.isArray(scoped) ? scoped : [],
  );
}

type SchemaContributionActionsRead =
  | { status: "ok"; hasActions: true; actions: unknown }
  | { status: "ok"; hasActions: false }
  | { status: "unreadable" };

function readSchemaContributionVisibility(
  pluginId: string,
  contribution: ChannelMessageToolSchemaContribution,
): ChannelMessageToolSchemaContribution["visibility"] {
  return readMessageToolDiscoveryValue({
    pluginId,
    field: "schema.visibility",
    fallback: "current-channel",
    read: () => contribution.visibility ?? "current-channel",
  });
}

function readSchemaContributionActions(
  pluginId: string,
  contribution: ChannelMessageToolSchemaContribution,
): SchemaContributionActionsRead {
  const hasActions = readMessageToolDiscoveryValue<boolean | null>({
    pluginId,
    field: "schema.actions",
    fallback: null,
    read: () => Object.hasOwn(contribution, "actions"),
  });
  if (hasActions === null) {
    return { status: "unreadable" };
  }
  if (!hasActions) {
    return { status: "ok", hasActions: false };
  }
  const actions = readMessageToolDiscoveryValue<unknown>({
    pluginId,
    field: "schema.actions",
    fallback: null,
    read: () => contribution.actions,
  });
  return actions === null ? { status: "unreadable" } : { status: "ok", hasActions: true, actions };
}

function readSchemaContributionProperties(
  pluginId: string,
  contribution: ChannelMessageToolSchemaContribution,
): Record<string, TSchema> | undefined {
  return readMessageToolDiscoveryValue({
    pluginId,
    field: "schema.properties",
    fallback: undefined,
    read: () => contribution.properties,
  });
}

function formatMessageToolDiscoveryField(base: string, key: PropertyKey): string {
  return `${base}.${typeof key === "symbol" ? String(key) : key}`;
}

/**
 * Finds the lightest available message-tool discovery adapter for one channel.
 */
export function resolveCurrentChannelMessageToolDiscoveryAdapter(channel?: string | null): {
  pluginId: string;
  actions: ChannelMessageToolDiscoveryAdapter;
} | null {
  const channelId = resolveMessageActionDiscoveryChannelId(channel);
  if (!channelId) {
    return null;
  }
  const loadedPlugin = getLoadedChannelPlugin(channelId as Parameters<typeof getChannelPlugin>[0]);
  if (loadedPlugin?.actions) {
    return {
      pluginId: loadedPlugin.id,
      actions: loadedPlugin.actions,
    };
  }
  // Prefer the bundled public artifact before full plugin materialization so
  // schema construction stays cheap on hot agent/tool paths.
  const bundledActions = resolveBundledChannelMessageToolDiscoveryAdapter(channelId);
  if (bundledActions) {
    return {
      pluginId: channelId,
      actions: bundledActions,
    };
  }
  const plugin = getChannelPlugin(channelId as Parameters<typeof getChannelPlugin>[0]);
  if (!plugin?.actions) {
    return null;
  }
  return {
    pluginId: plugin.id,
    actions: plugin.actions,
  };
}

/**
 * Resolves one plugin's message action metadata with caller-selected fields.
 */
export function resolveMessageActionDiscoveryForPlugin(params: {
  pluginId: string;
  actions?: ChannelMessageToolDiscoveryAdapter;
  context: ChannelMessageActionDiscoveryContext;
  action?: ChannelMessageActionName;
  includeActions?: boolean;
  includeCapabilities?: boolean;
  includeSchema?: boolean;
}): ResolvedChannelMessageActionDiscovery {
  const adapter = params.actions;
  if (!adapter) {
    return {
      actions: [],
      capabilities: [],
      schemaContributions: [],
      schemaContributionsUnreadable: false,
      mediaSourceParams: [],
    };
  }

  const described = describeMessageToolSafely({
    pluginId: params.pluginId,
    context: params.context,
    describeMessageTool: adapter.describeMessageTool,
  });
  const actions = params.includeActions
    ? readMessageToolDiscoveryValue({
        pluginId: params.pluginId,
        field: "actions",
        fallback: [],
        read: () => (Array.isArray(described?.actions) ? [...described.actions] : []),
      })
    : [];
  const capabilities = params.includeCapabilities
    ? readMessageToolDiscoveryValue({
        pluginId: params.pluginId,
        field: "capabilities",
        fallback: [],
        read: () => (Array.isArray(described?.capabilities) ? described.capabilities : []),
      })
    : [];
  const schemaRead = params.includeSchema
    ? readMessageToolDiscoveryValue({
        pluginId: params.pluginId,
        field: "schema",
        fallback: { contributions: [], unreadable: true },
        read: () => normalizeToolSchemaContributions(params.pluginId, described?.schema),
      })
    : { contributions: [], unreadable: false };
  const mediaSourceParams = readMessageToolDiscoveryValue({
    pluginId: params.pluginId,
    field: "mediaSourceParams",
    fallback: [],
    read: () => normalizeMessageToolMediaSourceParams(described?.mediaSourceParams, params.action),
  });
  return {
    actions,
    capabilities,
    schemaContributions: schemaRead.contributions,
    schemaContributionsUnreadable: schemaRead.unreadable,
    mediaSourceParams,
  };
}

/**
 * Lists message actions available across registered channel plugins.
 */
export function listChannelMessageActions(cfg: OpenClawConfig): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>(["send", "broadcast"]);
  for (const plugin of listChannelPlugins()) {
    for (const action of resolveMessageActionDiscoveryForPlugin({
      pluginId: plugin.id,
      actions: plugin.actions,
      context: { cfg },
      includeActions: true,
    }).actions) {
      actions.add(action);
    }
  }
  return Array.from(actions);
}

/**
 * Lists actions whose schemas do not block cross-channel tool usage.
 */
export function listCrossChannelSchemaSupportedMessageActions(
  params: ChannelMessageActionDiscoveryParams & {
    channel?: string;
  },
): ChannelMessageActionName[] {
  const channelId = resolveMessageActionDiscoveryChannelId(params.channel);
  if (!channelId) {
    return [];
  }
  const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(channelId);
  if (!pluginActions?.actions) {
    return [];
  }
  const resolved = resolveMessageActionDiscoveryForPlugin({
    pluginId: pluginActions.pluginId,
    actions: pluginActions.actions,
    context: createMessageActionDiscoveryContext(params),
    includeActions: true,
    includeSchema: true,
  });
  if (resolved.schemaContributionsUnreadable) {
    return [];
  }
  const schemaBlockedActions = new Set<ChannelMessageActionName>();
  for (const contribution of resolved.schemaContributions) {
    // Current-channel-only schema params are not safe for cross-channel tool
    // calls unless the plugin explicitly leaves an action without that schema.
    if (
      readSchemaContributionVisibility(pluginActions.pluginId, contribution) !== "current-channel"
    ) {
      continue;
    }
    const actionsRead = readSchemaContributionActions(pluginActions.pluginId, contribution);
    if (actionsRead.status === "unreadable" || !actionsRead.hasActions) {
      return [];
    }
    const { actions } = actionsRead;
    if (!Array.isArray(actions)) {
      return [];
    }
    if (actions.length === 0) {
      continue;
    }
    for (const action of actions) {
      schemaBlockedActions.add(action);
    }
  }
  return resolved.actions.filter((action) => !schemaBlockedActions.has(action));
}

/**
 * Lists message capabilities advertised across registered channel plugins.
 */
export function listChannelMessageCapabilities(cfg: OpenClawConfig): ChannelMessageCapability[] {
  const capabilities = new Set<ChannelMessageCapability>();
  for (const plugin of listChannelPlugins()) {
    for (const capability of resolveMessageActionDiscoveryForPlugin({
      pluginId: plugin.id,
      actions: plugin.actions,
      context: { cfg },
      includeCapabilities: true,
    }).capabilities) {
      capabilities.add(capability);
    }
  }
  return Array.from(capabilities);
}

/**
 * Lists message capabilities advertised by the current channel.
 */
export function listChannelMessageCapabilitiesForChannel(
  params: ChannelMessageActionDiscoveryParams,
): ChannelMessageCapability[] {
  const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(params.channel);
  if (!pluginActions) {
    return [];
  }
  return Array.from(
    resolveMessageActionDiscoveryForPlugin({
      pluginId: pluginActions.pluginId,
      actions: pluginActions.actions,
      context: createMessageActionDiscoveryContext(params),
      includeCapabilities: true,
    }).capabilities,
  );
}

/**
 * Merges schema properties while preserving the first plugin to define a key.
 */
function mergeToolSchemaProperties(
  target: Record<string, TSchema>,
  source: Record<string, TSchema> | undefined,
  pluginId: string,
) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return;
  }
  const keys = readMessageToolDiscoveryValue<PropertyKey[]>({
    pluginId,
    field: "schema.properties",
    fallback: [],
    read: () => Reflect.ownKeys(source),
  });
  for (const name of keys) {
    if (typeof name !== "string" || name in target) {
      continue;
    }
    const schema = readMessageToolDiscoveryValue<TSchema | undefined>({
      pluginId,
      field: formatMessageToolDiscoveryField("schema.properties", name),
      fallback: undefined,
      read: () => Reflect.get(source, name),
    });
    if (schema) {
      target[name] = schema;
    }
  }
}

/**
 * Resolves extra message-tool schema properties from channel discovery hooks.
 */
export function resolveChannelMessageToolSchemaProperties(
  params: ChannelMessageActionDiscoveryParams,
): Record<string, TSchema> {
  const properties: Record<string, TSchema> = {};
  const currentChannel = resolveMessageActionDiscoveryChannelId(params.channel);
  const discoveryBase = createMessageActionDiscoveryContext(params);
  const seenPluginIds = new Set<string>();

  for (const plugin of listChannelPlugins()) {
    if (!plugin.actions) {
      continue;
    }
    seenPluginIds.add(plugin.id);
    for (const contribution of resolveMessageActionDiscoveryForPlugin({
      pluginId: plugin.id,
      actions: plugin.actions,
      context: discoveryBase,
      includeSchema: true,
    }).schemaContributions) {
      const visibility = readSchemaContributionVisibility(plugin.id, contribution);
      if (currentChannel) {
        if (visibility === "all-configured" || plugin.id === currentChannel) {
          mergeToolSchemaProperties(
            properties,
            readSchemaContributionProperties(plugin.id, contribution),
            plugin.id,
          );
        }
        continue;
      }
      mergeToolSchemaProperties(
        properties,
        readSchemaContributionProperties(plugin.id, contribution),
        plugin.id,
      );
    }
  }
  if (currentChannel && !seenPluginIds.has(currentChannel)) {
    // The active channel may be bundled but not configured/registered yet; use
    // its lightweight discovery artifact so current-channel schemas still work.
    const currentActions = resolveCurrentChannelMessageToolDiscoveryAdapter(currentChannel);
    if (currentActions?.actions) {
      for (const contribution of resolveMessageActionDiscoveryForPlugin({
        pluginId: currentActions.pluginId,
        actions: currentActions.actions,
        context: discoveryBase,
        includeSchema: true,
      }).schemaContributions) {
        const visibility = readSchemaContributionVisibility(currentActions.pluginId, contribution);
        if (visibility === "all-configured" || currentActions.pluginId === currentChannel) {
          mergeToolSchemaProperties(
            properties,
            readSchemaContributionProperties(currentActions.pluginId, contribution),
            currentActions.pluginId,
          );
        }
      }
    }
  }

  return properties;
}

/**
 * Resolves tool parameter names that should be treated as media source selectors.
 */
export function resolveChannelMessageToolMediaSourceParamKeys(
  params: ChannelMessageToolMediaSourceParamKeyInput,
): string[] {
  const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(params.channel);
  if (!pluginActions) {
    return [];
  }
  const described = resolveMessageActionDiscoveryForPlugin({
    pluginId: pluginActions.pluginId,
    actions: pluginActions.actions,
    context: createMessageActionDiscoveryContext(params),
    action: params.action,
    includeSchema: false,
  });
  return uniqueStrings(described.mediaSourceParams);
}

/**
 * Returns whether any registered channel advertises a message capability.
 */
export function channelSupportsMessageCapability(
  cfg: OpenClawConfig,
  capability: ChannelMessageCapability,
): boolean {
  return listChannelMessageCapabilities(cfg).includes(capability);
}

/**
 * Returns whether the current channel advertises a message capability.
 */
export function channelSupportsMessageCapabilityForChannel(
  params: ChannelMessageActionDiscoveryParams,
  capability: ChannelMessageCapability,
): boolean {
  return listChannelMessageCapabilitiesForChannel(params).includes(capability);
}

export const testing = {
  resetLoggedMessageActionErrors() {
    loggedMessageActionErrors.clear();
  },
};
export { testing as __testing };
