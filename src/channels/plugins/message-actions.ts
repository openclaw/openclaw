import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { getChannelPlugin, listChannelPlugins } from "./index.js";
import type { ChannelMessageCapability } from "./message-capabilities.js";
import type { ChannelMessageActionContext, ChannelMessageActionName } from "./types.js";

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
  cfg: OpenClawConfig;
  listActions: NonNullable<ChannelActions["listActions"]>;
}): ChannelMessageActionName[] {
  try {
    const listed = params.listActions({ cfg: params.cfg });
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
      cfg,
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
  cfg: OpenClawConfig;
}): readonly ChannelMessageCapability[] {
  try {
    return params.actions.getCapabilities?.({ cfg: params.cfg }) ?? [];
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
      cfg,
    })) {
      capabilities.add(capability);
    }
  }
  return Array.from(capabilities);
}

export function listChannelMessageCapabilitiesForChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
}): ChannelMessageCapability[] {
  if (!params.channel) {
    return [];
  }
  const plugin = getChannelPlugin(params.channel as Parameters<typeof getChannelPlugin>[0]);
  return plugin?.actions
    ? Array.from(
        listCapabilities({
          pluginId: plugin.id,
          actions: plugin.actions,
          cfg: params.cfg,
        }),
      )
    : [];
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
