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

export function listChannelMessageActions(cfg: OpenClawConfig): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>(["send", "broadcast"]);
  for (const plugin of listChannelPlugins()) {
    const list = runSafeActionProbe({
      pluginId: plugin.id,
      probe: "listActions",
      fn: () => plugin.actions?.listActions?.({ cfg }) ?? [],
      fallback: [] as ChannelMessageActionName[],
    });
    for (const action of list) {
      actions.add(action);
    }
  }
  return Array.from(actions);
}

function listCapabilities(
  actions: ChannelActions,
  cfg: OpenClawConfig,
): readonly ChannelMessageCapability[] {
  return actions.getCapabilities?.({ cfg }) ?? [];
}

export function listChannelMessageCapabilities(cfg: OpenClawConfig): ChannelMessageCapability[] {
  const capabilities = new Set<ChannelMessageCapability>();
  for (const plugin of listChannelPlugins()) {
    const list = runSafeActionProbe({
      pluginId: plugin.id,
      probe: "getCapabilities",
      fn: () => (plugin.actions ? listCapabilities(plugin.actions, cfg) : []),
      fallback: [] as readonly ChannelMessageCapability[],
    });
    for (const capability of list) {
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
  const capabilities = runSafeActionProbe({
    pluginId: plugin?.id ?? params.channel,
    probe: "getCapabilitiesForChannel",
    fn: () => (plugin?.actions ? listCapabilities(plugin.actions, params.cfg) : []),
    fallback: [] as readonly ChannelMessageCapability[],
  });
  return Array.from(capabilities);
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

const loggedActionProbeErrors = new Set<string>();

export function _resetActionProbeErrorLogForTest(): void {
  loggedActionProbeErrors.clear();
}

function isToleratedActionProbeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("SecretRef");
}

function runSafeActionProbe<T>(params: {
  pluginId: string;
  probe: string;
  fn: () => T;
  fallback: T;
}): T {
  try {
    return params.fn();
  } catch (err) {
    if (!isToleratedActionProbeError(err)) {
      throw err;
    }
    logActionProbeError(params.pluginId, params.probe, err);
    return params.fallback;
  }
}

function logActionProbeError(pluginId: string, probe: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const key = `${pluginId}:${probe}:${message}`;
  if (loggedActionProbeErrors.has(key)) {
    return;
  }
  loggedActionProbeErrors.add(key);
  const stack = err instanceof Error && err.stack ? err.stack : null;
  const details = stack ?? message;
  defaultRuntime.error?.(`[channel-tools] ${pluginId}.actions.${probe} failed: ${details}`);
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
