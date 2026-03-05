import { createRequire } from "node:module";
import { GatewayIntents, GatewayPlugin } from "@buape/carbon/gateway";
import type { APIGatewayBotInfo } from "discord-api-types/v10";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import WebSocket from "ws";
import type { DiscordAccountConfig } from "../../config/types.js";
import { danger } from "../../globals.js";
import type { RuntimeEnv } from "../../runtime.js";

const requireFromHere = createRequire(import.meta.url);
type ProxyAgentCtor = new (proxy: string) => import("http").Agent;

function resolveHttpsProxyAgentCtor(): ProxyAgentCtor | null {
  try {
    const mod = requireFromHere("https-proxy-agent") as { HttpsProxyAgent?: unknown };
    if (typeof mod.HttpsProxyAgent !== "function") {
      return null;
    }
    return mod.HttpsProxyAgent as ProxyAgentCtor;
  } catch {
    return null;
  }
}

export function resolveDiscordGatewayIntents(
  intentsConfig?: import("../../config/types.discord.js").DiscordIntentsConfig,
): number {
  let intents =
    GatewayIntents.Guilds |
    GatewayIntents.GuildMessages |
    GatewayIntents.MessageContent |
    GatewayIntents.DirectMessages |
    GatewayIntents.GuildMessageReactions |
    GatewayIntents.DirectMessageReactions |
    GatewayIntents.GuildVoiceStates;
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
  const options = {
    reconnect: { maxAttempts: 50 },
    intents,
    autoInteractions: true,
  };

  if (!proxy) {
    return new GatewayPlugin(options);
  }

  try {
    const HttpsProxyAgent = resolveHttpsProxyAgentCtor();
    if (!HttpsProxyAgent) {
      params.runtime.error?.(
        danger("discord: gateway proxy requested but https-proxy-agent is unavailable"),
      );
      return new GatewayPlugin(options);
    }
    const wsAgent = new HttpsProxyAgent(proxy);
    const fetchAgent = new ProxyAgent(proxy);

    params.runtime.log?.("discord: gateway proxy enabled");

    class ProxyGatewayPlugin extends GatewayPlugin {
      constructor() {
        super(options);
      }

      override async registerClient(client: Parameters<GatewayPlugin["registerClient"]>[0]) {
        if (!this.gatewayInfo) {
          try {
            const response = await undiciFetch("https://discord.com/api/v10/gateway/bot", {
              headers: {
                Authorization: `Bot ${client.options.token}`,
              },
              dispatcher: fetchAgent,
            } as Record<string, unknown>);
            this.gatewayInfo = (await response.json()) as APIGatewayBotInfo;
          } catch (error) {
            throw new Error(
              `Failed to get gateway information from Discord: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
        }
        return super.registerClient(client);
      }

      override createWebSocket(url: string) {
        return new WebSocket(url, { agent: wsAgent });
      }
    }

    return new ProxyGatewayPlugin();
  } catch (err) {
    params.runtime.error?.(danger(`discord: invalid gateway proxy: ${String(err)}`));
    return new GatewayPlugin(options);
  }
}
