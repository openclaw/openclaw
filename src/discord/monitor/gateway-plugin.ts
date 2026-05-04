import { GatewayIntents, GatewayPlugin } from "@buape/carbon/gateway";
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import type { DiscordAccountConfig } from "../../config/types.js";
import { danger } from "../../globals.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createDiscordDnsLookup } from "../network-config.js";

export function resolveDiscordGatewayIntents(
  intentsConfig?: import("../../config/types.discord.js").DiscordIntentsConfig,
): number {
  let intents =
    GatewayIntents.Guilds |
    GatewayIntents.GuildMessages |
    GatewayIntents.MessageContent |
    GatewayIntents.DirectMessages |
    GatewayIntents.GuildMessageReactions |
    GatewayIntents.DirectMessageReactions;
  if (intentsConfig?.presence) {
    intents |= GatewayIntents.GuildPresences;
  }
  if (intentsConfig?.guildMembers) {
    intents |= GatewayIntents.GuildMembers;
  }
  return intents;
}

export function createDiscordGatewayPlugin(params: {
  discordConfig: DiscordAccountConfig;
  runtime: RuntimeEnv;
}): GatewayPlugin {
  const intents = resolveDiscordGatewayIntents(params.discordConfig?.intents);
  const proxy = params.discordConfig?.proxy?.trim();
  const lookup = createDiscordDnsLookup();
  const options = {
    reconnect: { maxAttempts: 50 },
    intents,
    autoInteractions: true,
  };

  class LookupAwareGatewayPlugin extends GatewayPlugin {
    constructor() {
      super(options);
    }

    createWebSocket(url: string) {
      return new WebSocket(url, { lookup });
    }
  }

  if (!proxy) {
    return new LookupAwareGatewayPlugin();
  }

  try {
    const agent = new HttpsProxyAgent<string>(proxy);

    params.runtime.log?.("discord: gateway proxy enabled");

    class ProxyGatewayPlugin extends LookupAwareGatewayPlugin {
      constructor() {
        super(options);
      }

      createWebSocket(url: string) {
        return new WebSocket(url, { agent, lookup });
      }
    }

    return new ProxyGatewayPlugin();
  } catch (err) {
    params.runtime.error?.(danger(`discord: invalid gateway proxy: ${String(err)}`));
    return new GatewayPlugin(options);
  }
}
