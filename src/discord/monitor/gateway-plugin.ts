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

/**
 * Default gateway info used when the Discord API is unreachable.
 * Provides the standard gateway URL so Carbon's reconnect logic can still
 * attempt WebSocket connections with exponential backoff.
 */
const FALLBACK_GATEWAY_INFO: APIGatewayBotInfo = {
  url: "wss://gateway.discord.gg/",
  shards: 1,
  session_start_limit: {
    total: 1000,
    remaining: 1000,
    reset_after: 14_400_000,
    max_concurrency: 1,
  },
};

/**
 * Log a registerClient failure instead of letting it become an unhandled
 * promise rejection that crashes the gateway process.
 */
function logRegisterClientFailure(error: unknown, runtime: RuntimeEnv): void {
  runtime.error?.(
    danger(
      `discord: gateway registerClient failed: ${error instanceof Error ? error.message : String(error)}. ` +
        "The gateway will remain disconnected; other channels are unaffected.",
    ),
  );
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
    // No proxy — still need to guard against unhandled rejections from
    // Carbon's registerClient (which fetches gateway info via native fetch).
    // Carbon's Client constructor calls plugin.registerClient() without
    // awaiting the returned promise, so any rejection becomes unhandled.
    class SafeGatewayPlugin extends GatewayPlugin {
      constructor() {
        super(options);
      }

      override async registerClient(
        client: Parameters<GatewayPlugin["registerClient"]>[0],
      ): Promise<void> {
        try {
          await super.registerClient(client);
        } catch (error) {
          logRegisterClientFailure(error, params.runtime);
        }
      }
    }

    return new SafeGatewayPlugin();
  }

  try {
    const wsAgent = new HttpsProxyAgent<string>(proxy);
    const fetchAgent = new ProxyAgent(proxy);

    params.runtime.log?.("discord: gateway proxy enabled");

    class ProxyGatewayPlugin extends GatewayPlugin {
      constructor() {
        super(options);
      }

      override async registerClient(
        client: Parameters<GatewayPlugin["registerClient"]>[0],
      ): Promise<void> {
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
            params.runtime.error?.(
              danger(
                `discord: failed to fetch gateway info via proxy: ${error instanceof Error ? error.message : String(error)}. ` +
                  "Falling back to default gateway URL.",
              ),
            );
            this.gatewayInfo = { ...FALLBACK_GATEWAY_INFO };
          }
        }
        try {
          await super.registerClient(client);
        } catch (error) {
          logRegisterClientFailure(error, params.runtime);
        }
      }

      override createWebSocket(url: string) {
        return new WebSocket(url, { agent: wsAgent });
      }
    }

    return new ProxyGatewayPlugin();
  } catch (err) {
    params.runtime.error?.(danger(`discord: invalid gateway proxy: ${String(err)}`));

    // Fall back to a safe non-proxy plugin.
    class SafeGatewayPlugin extends GatewayPlugin {
      constructor() {
        super(options);
      }

      override async registerClient(
        client: Parameters<GatewayPlugin["registerClient"]>[0],
      ): Promise<void> {
        try {
          await super.registerClient(client);
        } catch (error) {
          logRegisterClientFailure(error, params.runtime);
        }
      }
    }

    return new SafeGatewayPlugin();
  }
}
