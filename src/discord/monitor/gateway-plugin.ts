import { GatewayIntents, GatewayPlugin } from "@buape/carbon/gateway";
import type { APIGatewayBotInfo } from "discord-api-types/v10";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import WebSocket from "ws";
import type { DiscordAccountConfig } from "../../config/types.js";
import { danger } from "../../globals.js";
import type { RuntimeEnv } from "../../runtime.js";

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
    const wsAgent = new HttpsProxyAgent<string>(proxy);
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
            const bodyText = await response.text();
            if (!response.ok) {
              const preview = bodyText.trim().slice(0, 160) || `<http ${response.status}>`;
              params.runtime.error?.(
                danger(
                  `discord: failed to fetch gateway metadata through proxy, status=${response.status}, body=${JSON.stringify(preview)}`,
                ),
              );
            } else {
              try {
                this.gatewayInfo = JSON.parse(bodyText) as APIGatewayBotInfo;
              } catch (error) {
                const preview = bodyText.trim().slice(0, 160) || "<empty>";
                params.runtime.error?.(
                  danger(
                    `discord: invalid gateway metadata response through proxy, body=${JSON.stringify(preview)}, error=${error instanceof Error ? error.message : String(error)}`,
                  ),
                );
              }
            }
          } catch (error) {
            params.runtime.error?.(
              danger(
                `discord: failed to fetch gateway metadata through proxy: ${error instanceof Error ? error.message : String(error)}`,
              ),
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
