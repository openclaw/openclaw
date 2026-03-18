import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { getChannelPlugin, listChannelPlugins } from "./index.js";
import {
  createMessageActionDiscoveryContext,
  resolveMessageActionDiscoveryChannelId,
} from "./message-action-discovery.js";
import type { ChannelMessageCapability } from "./message-capabilities.js";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionDiscoveryContext,
  ChannelMessageActionName,
  ChannelMessageToolSchemaContribution,
} from "./types.js";

type ChannelActions = NonNullable<NonNullable<ReturnType<typeof getChannelPlugin>>["actions"]>;

function requiresTrustedRequesterSender(ctx: ChannelMessageActionContext): boolean {
  const plugin = getChannelPlugin(ctx.channel);
  return Boolean(
    plugin?.actions?.requiresTrustedRequesterSender?.({
      action: ctx.action,
      toolContext: ctx.toolContext,
    }),
  );
}

const loggedMessageActionErrors = new Set<string>();

function logMessageActionError(params: {
  pluginId: string;
  operation: "listActions" | "getCapabilities";
  error: unknown;
}) {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  const key = `${params.pluginId}:${params.operation}:${message}`;
  if (loggedMessageActionErrors.has(key)) {
    return;
  }
  loggedMessageActionErrors.add(key);
  const stack = params.error instanceof Error && params.error.stack ? params.error.stack : null;
  defaultRuntime.error?.(
    `[message-actions] ${params.pluginId}.actions.${params.operation} failed: ${stack ?? message}`,
  );
}

function runListActionsSafely(params: {
  pluginId: string;
  context: ChannelMessageActionDiscoveryContext;
  listActions: NonNullable<ChannelActions["listActions"]>;
}): ChannelMessageActionName[] {
  try {
    const listed = params.listActions(params.context);
    return Array.isArray(listed) ? listed : [];
  } catch (error) {
    logMessageActionError({
      pluginId: params.pluginId,
      operation: "listActions",
      error,
    });
    return [];
  }
}

export function listChannelMessageActions(cfg: OpenClawConfig): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>(["send", "broadcast"]);
  for (const plugin of listChannelPlugins()) {
    if (!plugin.actions?.listActions) {
      continue;
    }
    const list = runListActionsSafely({
      pluginId: plugin.id,
      context: { cfg },
      listActions: plugin.actions.listActions,
    });
    for (const action of list) {
      actions.add(action);
    }
  }
  return Array.from(actions);
}

function listCapabilities(params: {
  pluginId: string;
  actions: ChannelActions;
  context: ChannelMessageActionDiscoveryContext;
}): readonly ChannelMessageCapability[] {
  try {
    return params.actions.getCapabilities?.(params.context) ?? [];
  } catch (error) {
    logMessageActionError({
      pluginId: params.pluginId,
      operation: "getCapabilities",
      error,
    });
    return [];
  }
}

export function listChannelMessageCapabilities(cfg: OpenClawConfig): ChannelMessageCapability[] {
  const capabilities = new Set<ChannelMessageCapability>();
  for (const plugin of listChannelPlugins()) {
    if (!plugin.actions) {
      continue;
    }
    for (const capability of listCapabilities({
      pluginId: plugin.id,
      actions: plugin.actions,
      context: { cfg },
    })) {
      capabilities.add(capability);
    }
  }
  return Array.from(capabilities);
}

export function listChannelMessageCapabilitiesForChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
}): ChannelMessageCapability[] {
  const channelId = resolveMessageActionDiscoveryChannelId(params.channel);
  if (!channelId) {
    return [];
  }
  const plugin = getChannelPlugin(channelId as Parameters<typeof getChannelPlugin>[0]);
  return plugin?.actions
    ? Array.from(
        listCapabilities({
          pluginId: plugin.id,
          actions: plugin.actions,
          context: createMessageActionDiscoveryContext(params),
        }),
      )
    : [];
}

function logMessageActionSchemaError(params: { pluginId: string; error: unknown }) {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  const key = `${params.pluginId}:getToolSchema:${message}`;
  if (loggedMessageActionErrors.has(key)) {
    return;
  }
  loggedMessageActionErrors.add(key);
  const stack = params.error instanceof Error && params.error.stack ? params.error.stack : null;
  defaultRuntime.error?.(
    `[message-actions] ${params.pluginId}.actions.getToolSchema failed: ${stack ?? message}`,
  );
}

function normalizeToolSchemaContributions(
  value:
    | ChannelMessageToolSchemaContribution
    | ChannelMessageToolSchemaContribution[]
    | null
    | undefined,
): ChannelMessageToolSchemaContribution[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function mergeToolSchemaProperties(
  target: Record<string, TSchema>,
  source: Record<string, TSchema> | undefined,
) {
  if (!source) {
    return;
  }
  for (const [name, schema] of Object.entries(source)) {
    if (!(name in target)) {
      target[name] = schema;
    }
  }
}

export function resolveChannelMessageToolSchemaProperties(params: {
  cfg: OpenClawConfig;
  channel?: string;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
}): Record<string, TSchema> {
  const properties: Record<string, TSchema> = {};
  const plugins = listChannelPlugins();
  const currentChannel = resolveMessageActionDiscoveryChannelId(params.channel);
  const discoveryBase: ChannelMessageActionDiscoveryContext =
    createMessageActionDiscoveryContext(params);

  for (const plugin of plugins) {
    const getToolSchema = plugin?.actions?.getToolSchema;
    if (!plugin || !getToolSchema) {
      continue;
    }
    try {
      const contributions = normalizeToolSchemaContributions(getToolSchema(discoveryBase));
      for (const contribution of contributions) {
        const visibility = contribution.visibility ?? "current-channel";
        if (currentChannel) {
          if (visibility === "all-configured" || plugin.id === currentChannel) {
            mergeToolSchemaProperties(properties, contribution.properties);
          }
          continue;
        }
        mergeToolSchemaProperties(properties, contribution.properties);
      }
    } catch (error) {
      logMessageActionSchemaError({
        pluginId: plugin.id,
        error,
      });
    }
  }

  return properties;
}

export function channelSupportsMessageCapability(
  cfg: OpenClawConfig,
  capability: ChannelMessageCapability,
): boolean {
  return listChannelMessageCapabilities(cfg).includes(capability);
}

export function channelSupportsMessageCapabilityForChannel(
  params: {
    cfg: OpenClawConfig;
    channel?: string;
    currentChannelId?: string | null;
    currentThreadTs?: string | null;
    currentMessageId?: string | number | null;
    accountId?: string | null;
    sessionKey?: string | null;
    sessionId?: string | null;
    agentId?: string | null;
    requesterSenderId?: string | null;
  },
  capability: ChannelMessageCapability,
): boolean {
  return listChannelMessageCapabilitiesForChannel(params).includes(capability);
}

export async function dispatchChannelMessageAction(
  ctx: ChannelMessageActionContext,
): Promise<AgentToolResult<unknown> | null> {
  if (requiresTrustedRequesterSender(ctx) && !ctx.requesterSenderId?.trim()) {
    throw new Error(
      `Trusted sender identity is required for ${ctx.channel}:${ctx.action} in tool-driven contexts.`,
    );
  }
  const plugin = getChannelPlugin(ctx.channel);
  if (!plugin?.actions?.handleAction) {
    return null;
  }
  if (plugin.actions.supportsAction && !plugin.actions.supportsAction({ action: ctx.action })) {
    return null;
  }
  return await plugin.actions.handleAction(ctx);
}

export const __testing = {
  resetLoggedMessageActionErrors() {
    loggedMessageActionErrors.clear();
  },
};
