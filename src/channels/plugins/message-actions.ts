import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import type { ChannelMessageActionContext, ChannelMessageActionName } from "./types.js";
import { getChannelPlugin, listChannelPlugins } from "./index.js";

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

export function supportsChannelMessageCards(cfg: OpenClawConfig): boolean {
  for (const plugin of listChannelPlugins()) {
    if (plugin.actions?.supportsCards?.({ cfg })) {
      return true;
    }
  }
  return false;
}

export async function dispatchChannelMessageAction(
  ctx: ChannelMessageActionContext,
): Promise<AgentToolResult<unknown> | null> {
  const plugin = getChannelPlugin(ctx.channel);
  if (plugin?.actions?.handleAction) {
    const supported =
      !plugin.actions.supportsAction || plugin.actions.supportsAction({ action: ctx.action });
    if (supported) {
      return await plugin.actions.handleAction(ctx);
    }
  }

  // Cross-channel fallback: the inferred channel doesn't support this action.
  // Try other loaded channel plugins (e.g. X actions invoked from Feishu).
  for (const candidate of listChannelPlugins()) {
    if (candidate.id === ctx.channel) {
      continue;
    }
    if (!candidate.actions?.handleAction) {
      continue;
    }
    if (
      candidate.actions.supportsAction &&
      !candidate.actions.supportsAction({ action: ctx.action })
    ) {
      continue;
    }
    // Found a plugin that supports the action — dispatch with corrected channel.
    return await candidate.actions.handleAction({ ...ctx, channel: candidate.id });
  }

  return null;
}
