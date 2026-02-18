import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { getChannelPlugin, listChannelPlugins } from "./index.js";
import type { ChannelMessageActionContext, ChannelMessageActionName } from "./types.js";

export function listChannelMessageActions(cfg: OpenClawConfig): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>(["send", "broadcast"]);
  for (const plugin of listChannelPlugins()) {
    const list = plugin.actions?.listActions?.({ cfg });
    if (!list) {
      continue;
    }
    for (const action of list) {
      actions.add(action);
    }
  }
  return Array.from(actions);
}

export function supportsChannelMessageButtons(cfg: OpenClawConfig): boolean {
  for (const plugin of listChannelPlugins()) {
    if (plugin.actions?.supportsButtons?.({ cfg })) {
      return true;
    }
  }
  return false;
}

export function supportsChannelMessageButtonsForChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
}): boolean {
  if (!params.channel) {
    return false;
  }
  const plugin = getChannelPlugin(params.channel as Parameters<typeof getChannelPlugin>[0]);
  return plugin?.actions?.supportsButtons?.({ cfg: params.cfg }) === true;
}

export function supportsChannelMessageCards(cfg: OpenClawConfig): boolean {
  for (const plugin of listChannelPlugins()) {
    if (plugin.actions?.supportsCards?.({ cfg })) {
      return true;
    }
  }
  return false;
}

export function supportsChannelMessageCardsForChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
}): boolean {
  if (!params.channel) {
    return false;
  }
  const plugin = getChannelPlugin(params.channel as Parameters<typeof getChannelPlugin>[0]);
  return plugin?.actions?.supportsCards?.({ cfg: params.cfg }) === true;
}

export async function dispatchChannelMessageAction(
  ctx: ChannelMessageActionContext,
): Promise<AgentToolResult<unknown> | null> {
  console.log(`[message-actions] Dispatching action: ${ctx.action} for channel: ${ctx.channel}`);
  const plugin = getChannelPlugin(ctx.channel);
  if (!plugin?.actions?.handleAction) {
    console.log(`[message-actions] No handler found for channel: ${ctx.channel}`);
    return null;
  }
  if (plugin.actions.supportsAction && !plugin.actions.supportsAction({ action: ctx.action })) {
    console.log(`[message-actions] Action ${ctx.action} not supported by channel: ${ctx.channel}`);
    return null;
  }
  console.log(`[message-actions] Executing action ${ctx.action} via plugin handler`);
  return await plugin.actions.handleAction(ctx);
}
