import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { getChannelPlugin, listChannelPlugins } from "./index.js";
import type { ChannelMessageActionContext, ChannelMessageActionName } from "./types.js";

const trustedRequesterRequiredByChannel: Readonly<
  Partial<Record<string, ReadonlySet<ChannelMessageActionName>>>
> = {
  discord: new Set<ChannelMessageActionName>(["timeout", "kick", "ban"]),
};

type ChannelActions = NonNullable<NonNullable<ReturnType<typeof getChannelPlugin>>["actions"]>;

function requiresTrustedRequesterSender(ctx: ChannelMessageActionContext): boolean {
  const actions = trustedRequesterRequiredByChannel[ctx.channel];
  return Boolean(actions?.has(ctx.action) && ctx.toolContext);
}

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
  return supportsMessageFeature(cfg, (actions) => actions?.supportsButtons?.({ cfg }) === true);
}

export function supportsChannelMessageButtonsForChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
}): boolean {
  return supportsMessageFeatureForChannel(
    params,
    (actions) => actions.supportsButtons?.(params) === true,
  );
}

export function supportsChannelMessageCards(cfg: OpenClawConfig): boolean {
  return supportsMessageFeature(cfg, (actions) => actions?.supportsCards?.({ cfg }) === true);
}

export function supportsChannelMessageCardsForChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
}): boolean {
  return supportsMessageFeatureForChannel(
    params,
    (actions) => actions.supportsCards?.(params) === true,
  );
}

function supportsMessageFeature(
  cfg: OpenClawConfig,
  check: (actions: ChannelActions) => boolean,
): boolean {
  for (const plugin of listChannelPlugins()) {
    if (plugin.actions && check(plugin.actions)) {
      return true;
    }
  }
  return false;
}

function supportsMessageFeatureForChannel(
  params: {
    cfg: OpenClawConfig;
    channel?: string;
  },
  check: (actions: ChannelActions) => boolean,
): boolean {
  if (!params.channel) {
    return false;
  }
  const plugin = getChannelPlugin(params.channel as Parameters<typeof getChannelPlugin>[0]);
  return plugin?.actions ? check(plugin.actions) : false;
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
