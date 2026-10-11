import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { Type, type TSchema } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getPreparedMessageToolCatalog,
  type PreparedMessageToolCatalog,
} from "../../plugins/prepared-message-tool-catalog.js";
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

export type { PreparedMessageToolCatalog } from "../../plugins/prepared-message-tool-catalog.js";

/** Lists message-action adapters from the caller's exact prepared registry. */
export const listMessageActionDiscoveryChannels = (
  preparedMessageToolCatalog?: PreparedMessageToolCatalog,
) =>
  (preparedMessageToolCatalog ?? getPreparedMessageToolCatalog())?.channels ?? listChannelPlugins();

export type ChannelMessageActionDiscoveryInput = Omit<
  ChannelMessageActionDiscoveryContext,
  "cfg"
> & {
  cfg?: OpenClawConfig;
  channel?: string | null;
};

type ChannelMessageActionDiscoveryParams = ChannelMessageActionDiscoveryInput & {
  cfg: OpenClawConfig;
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
};

type ChannelMessageToolMediaSourceParamKeyInput = ChannelMessageActionDiscoveryParams & {
  action?: ChannelMessageActionName;
};

const loggedMessageActionErrors = new Set<string>();

export function resolveMessageActionDiscoveryChannelId(raw?: string | null): string | undefined {
  return normalizeAnyChannelId(raw) ?? normalizeOptionalString(raw);
}

export function createMessageActionDiscoveryContext(
  params: ChannelMessageActionDiscoveryInput,
): ChannelMessageActionDiscoveryContext {
  const currentChannelProvider = resolveMessageActionDiscoveryChannelId(
    params.channel ?? params.currentChannelProvider,
  );
  return {
    cfg: params.cfg ?? {},
    ...(params.chatType ? { chatType: params.chatType } : {}),
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

function describeMessageToolSafely(params: {
  pluginId: string;
  context: ChannelMessageActionDiscoveryContext;
  actions: ChannelMessageToolDiscoveryAdapter;
}): ChannelMessageToolDiscovery | null {
  try {
    return params.actions.describeMessageTool(params.context) ?? null;
  } catch (error) {
    reportDiscoveryError(params.pluginId, error);
    return null;
  }
}

function reportDiscoveryError(pluginId: string, error: unknown) {
  const message = formatErrorMessage(error);
  const key = `${pluginId}:describeMessageTool:${message}`;
  // Discovery runs while building tool schemas, so report each plugin/error pair once.
  if (!loggedMessageActionErrors.has(key)) {
    loggedMessageActionErrors.add(key);
    const stack = error instanceof Error && error.stack ? error.stack : null;
    defaultRuntime.error?.(
      `[message-action-discovery] ${pluginId}.actions.describeMessageTool failed: ${stack ?? message}`,
    );
  }
}

type ResolvedChannelMessageActionDiscovery = {
  actions: ChannelMessageActionName[];
  capabilities: readonly ChannelMessageCapability[];
  schemaContributions: ChannelMessageToolSchemaContribution[];
  mediaSourceParams: readonly string[];
};

type MessageToolMediaSourceParamMap = Partial<Record<ChannelMessageActionName, readonly string[]>>;

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

export function resolveCurrentChannelMessageToolDiscoveryAdapter(
  channel?: string | null,
  preparedMessageToolCatalog?: PreparedMessageToolCatalog,
): {
  pluginId: string;
  actions: ChannelMessageToolDiscoveryAdapter;
} | null {
  const channelId = resolveMessageActionDiscoveryChannelId(channel);
  if (!channelId) {
    return null;
  }
  const catalog = preparedMessageToolCatalog ?? getPreparedMessageToolCatalog();
  const prepared = catalog?.getChannel(channelId);
  if (prepared?.actions) {
    return { pluginId: prepared.id, actions: prepared.actions };
  }
  if (!catalog) {
    const loadedPlugin = getLoadedChannelPlugin(channelId);
    if (loadedPlugin?.actions) {
      return {
        pluginId: loadedPlugin.id,
        actions: loadedPlugin.actions,
      };
    }
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
  const plugin = catalog ? undefined : getChannelPlugin(channelId);
  return plugin?.actions ? { pluginId: plugin.id, actions: plugin.actions } : null;
}

type MessageActionDiscoveryRequest = {
  pluginId: string;
  actions?: ChannelMessageToolDiscoveryAdapter;
  context: ChannelMessageActionDiscoveryContext;
  action?: ChannelMessageActionName;
  includeActions?: boolean;
  includeCapabilities?: boolean;
  includeSchema?: boolean;
};

export type MessageActionDiscoverySteps<T> = Generator<
  MessageActionDiscoveryRequest,
  T,
  ResolvedChannelMessageActionDiscovery
>;

export function runMessageActionDiscovery<T>(steps: MessageActionDiscoverySteps<T>): T {
  let next = steps.next();
  while (!next.done) {
    next = steps.next(resolveMessageActionDiscoveryForPlugin(next.value));
  }
  return next.value;
}

export async function runMessageActionDiscoveryAsync<T>(
  steps: MessageActionDiscoverySteps<T>,
): Promise<T> {
  // One complete descriptor supplies every projection within this assembly only.
  const descriptions = new Map<
    ChannelMessageToolDiscoveryAdapter,
    {
      cfg: OpenClawConfig;
      contextKey: string;
      described: ChannelMessageToolDiscovery | null | undefined;
    }[]
  >();
  let next = steps.next();
  while (!next.done) {
    const request = next.value;
    const { cfg, ...contextFacts } = request.context;
    const contextKey = JSON.stringify(
      Object.entries(contextFacts)
        .filter(([, value]) => value !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right)),
    );
    const adapterDescriptions = request.actions ? (descriptions.get(request.actions) ?? []) : [];
    let prepared = adapterDescriptions.find(
      (entry) => entry.cfg === cfg && entry.contextKey === contextKey,
    );
    if (!prepared) {
      prepared = {
        cfg,
        contextKey,
        described: await describeMessageToolAsync(request),
      };
      if (request.actions) {
        adapterDescriptions.push(prepared);
        descriptions.set(request.actions, adapterDescriptions);
      }
    }
    next = steps.next(projectMessageActionDiscovery(request, prepared.described));
  }
  return next.value;
}

function resolveMessageActionDiscoveryForPlugin(
  params: MessageActionDiscoveryRequest,
): ResolvedChannelMessageActionDiscovery {
  const adapter = params.actions;
  const described = adapter
    ? describeMessageToolSafely({
        pluginId: params.pluginId,
        context: params.context,
        actions: adapter,
      })
    : null;
  return projectMessageActionDiscovery(params, described);
}

export async function resolveMessageActionDiscoveryForPluginAsync(
  params: MessageActionDiscoveryRequest,
): Promise<ResolvedChannelMessageActionDiscovery> {
  return projectMessageActionDiscovery(params, await describeMessageToolAsync(params));
}

async function describeMessageToolAsync(
  params: MessageActionDiscoveryRequest,
): Promise<ChannelMessageToolDiscovery | null | undefined> {
  if (!params.actions) {
    return null;
  }
  if (!params.actions.describeMessageToolAsync) {
    return describeMessageToolSafely({ ...params, actions: params.actions });
  }
  try {
    return await params.actions.describeMessageToolAsync(params.context);
  } catch (error) {
    reportDiscoveryError(params.pluginId, error);
    return null;
  }
}

function projectMessageActionDiscovery(
  params: MessageActionDiscoveryRequest,
  described: ChannelMessageToolDiscovery | null | undefined,
): ResolvedChannelMessageActionDiscovery {
  const schema = params.includeSchema ? described?.schema : undefined;
  return {
    actions:
      params.includeActions && Array.isArray(described?.actions) ? [...described.actions] : [],
    capabilities:
      params.includeCapabilities && Array.isArray(described?.capabilities)
        ? described.capabilities
        : [],
    schemaContributions: schema ? (Array.isArray(schema) ? schema : [schema]) : [],
    mediaSourceParams: normalizeMessageToolMediaSourceParams(
      described?.mediaSourceParams,
      params.action,
    ),
  };
}

export function* listCrossChannelSchemaSupportedMessageActionsSteps(
  params: ChannelMessageActionDiscoveryParams,
): MessageActionDiscoverySteps<ChannelMessageActionName[]> {
  const resolved = yield* resolveCurrentMessageActionDiscoverySteps(params, {
    includeActions: true,
    includeSchema: true,
  });
  if (!resolved) {
    return [];
  }
  const schemaBlockedActions = new Set<ChannelMessageActionName>();
  for (const contribution of resolved.schemaContributions) {
    // Current-channel-only schema params are not safe for cross-channel tool
    // calls unless the plugin explicitly leaves an action without that schema.
    if ((contribution.visibility ?? "current-channel") !== "current-channel") {
      continue;
    }
    if (!Object.hasOwn(contribution, "actions")) {
      return [];
    }
    const actions = contribution.actions;
    if (!Array.isArray(actions)) {
      return [];
    }
    for (const action of actions) {
      schemaBlockedActions.add(action);
    }
  }
  return resolved.actions.filter((action) => !schemaBlockedActions.has(action));
}

/**
 * Merges schema properties while preserving the first plugin to define a key.
 */
function mergeToolSchemaProperties(
  target: Record<string, TSchema>,
  source: Record<string, TSchema> | undefined,
) {
  if (!source) {
    return;
  }
  for (const [name, schema] of Object.entries(source)) {
    if (name in target) {
      continue;
    }
    // Message-tool params dispatch on `action`; no contributed property may be
    // object-level required. Type.Object treats schemas missing typebox's
    // non-enumerable `~optional` marker (plain JSON or cloned/serialized plugin
    // schemas) as required, which fails validation for every message call.
    target[name] = Type.IsOptional(schema) ? schema : Type.Optional(schema);
  }
}

type ChannelMessageToolSchemaParams = ChannelMessageActionDiscoveryParams & {
  /** Internal caller-owned account selection after the usual provider scoping. */
  resolveAccountIdForChannel?: (
    channel: string,
    contextualAccountId: ChannelMessageActionDiscoveryInput["accountId"],
  ) => ChannelMessageActionDiscoveryInput["accountId"];
};

export function* resolveChannelMessageToolSchemaPropertiesSteps(
  params: ChannelMessageToolSchemaParams,
): MessageActionDiscoverySteps<Record<string, TSchema>> {
  const properties: Record<string, TSchema> = {};
  const currentChannel = resolveMessageActionDiscoveryChannelId(params.channel);
  const discoveryBase = createMessageActionDiscoveryContext(params);
  // Account IDs belong to the current provider. Other plugins must discover
  // schemas from their configured-account union, not a foreign account name.
  const contextForPlugin = (pluginId: string) => {
    const contextualAccountId =
      !currentChannel || resolveMessageActionDiscoveryChannelId(pluginId) === currentChannel
        ? params.accountId
        : undefined;
    return {
      ...discoveryBase,
      accountId: params.resolveAccountIdForChannel
        ? params.resolveAccountIdForChannel(pluginId, contextualAccountId)
        : contextualAccountId,
    };
  };
  const seenPluginIds = new Set<string>();
  function* mergePluginSchema(
    pluginId: string,
    actions: ChannelMessageToolDiscoveryAdapter,
  ): MessageActionDiscoverySteps<void> {
    const discovered = yield {
      pluginId,
      actions,
      context: contextForPlugin(pluginId),
      includeSchema: true,
    };
    for (const contribution of discovered.schemaContributions) {
      const visibility = contribution.visibility ?? "current-channel";
      if (!currentChannel || visibility === "all-configured" || pluginId === currentChannel) {
        mergeToolSchemaProperties(properties, contribution.properties);
      }
    }
  }

  const channels = listMessageActionDiscoveryChannels(params.preparedMessageToolCatalog);
  for (const plugin of channels) {
    if (!plugin.actions) {
      continue;
    }
    seenPluginIds.add(plugin.id);
    yield* mergePluginSchema(plugin.id, plugin.actions);
  }
  if (currentChannel && !seenPluginIds.has(currentChannel)) {
    // The active channel may be bundled but not configured/registered yet; use
    // its lightweight discovery artifact so current-channel schemas still work.
    const currentActions = resolveCurrentChannelMessageToolDiscoveryAdapter(
      currentChannel,
      params.preparedMessageToolCatalog,
    );
    if (currentActions?.actions) {
      yield* mergePluginSchema(currentActions.pluginId, currentActions.actions);
    }
  }

  return properties;
}

export function* resolveCurrentMessageActionDiscoverySteps(
  params: ChannelMessageToolMediaSourceParamKeyInput,
  selection: {
    includeActions?: boolean;
    includeCapabilities?: boolean;
    includeSchema?: boolean;
  } = {},
): MessageActionDiscoverySteps<ResolvedChannelMessageActionDiscovery | null> {
  const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(
    params.channel,
    params.preparedMessageToolCatalog,
  );
  return pluginActions
    ? yield {
        ...pluginActions,
        context: createMessageActionDiscoveryContext(params),
        action: params.action,
        ...selection,
      }
    : null;
}

export async function resolveChannelMessageToolMediaSourceParamKeysAsync(
  params: ChannelMessageToolMediaSourceParamKeyInput,
): Promise<string[]> {
  const discovered = await runMessageActionDiscoveryAsync(
    resolveCurrentMessageActionDiscoverySteps(params),
  );
  return uniqueStrings(discovered?.mediaSourceParams ?? []);
}
