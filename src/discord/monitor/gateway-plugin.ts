import { GatewayIntents, GatewayPlugin } from "@buape/carbon/gateway";
import type { APIGatewayBotInfo } from "discord-api-types/v10";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import WebSocket from "ws";
import type { DiscordAccountConfig } from "../../config/types.js";
import { danger } from "../../globals.js";
import type { RuntimeEnv } from "../../runtime.js";

type RegistrationAwareGatewayPlugin = GatewayPlugin & {
  waitForRegistration: () => Promise<void>;
};

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

  class ManagedGatewayPlugin extends GatewayPlugin {
    private registrationPromise: Promise<void> | null = null;

    constructor() {
      super(options);
    }

    override registerClient(client: Parameters<GatewayPlugin["registerClient"]>[0]) {
      if (!this.registrationPromise) {
        this.registrationPromise = this.registerClientSafely(client);
        // Carbon calls plugin registration synchronously and does not await it.
        // Attach a local rejection handler so network failures become explicit
        // channel startup errors instead of process-level unhandled rejections.
        void this.registrationPromise.catch(() => {});
      }
      return this.registrationPromise;
    }

    waitForRegistration(): Promise<void> {
      return this.registrationPromise ?? Promise.resolve();
    }

    protected async registerClientSafely(
      client: Parameters<GatewayPlugin["registerClient"]>[0],
    ): Promise<void> {
      await super.registerClient(client);
    }
  }

  if (!proxy) {
    return new ManagedGatewayPlugin();
  }

  try {
    const wsAgent = new HttpsProxyAgent<string>(proxy);
    const fetchAgent = new ProxyAgent(proxy);

    params.runtime.log?.("discord: gateway proxy enabled");

    class ProxyGatewayPlugin extends ManagedGatewayPlugin {
      override async registerClientSafely(
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
            throw new Error(
              `Failed to get gateway information from Discord: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
        }
        await super.registerClientSafely(client);
      }

      override createWebSocket(url: string) {
        return new WebSocket(url, { agent: wsAgent });
      }
    }

    return new ProxyGatewayPlugin();
  } catch (err) {
    params.runtime.error?.(danger(`discord: invalid gateway proxy: ${String(err)}`));
    return new ManagedGatewayPlugin();
  }
}

export async function waitForDiscordGatewayRegistration(
  gateway?: GatewayPlugin,
): Promise<void> {
  const managedGateway = gateway as RegistrationAwareGatewayPlugin | undefined;
  await managedGateway?.waitForRegistration?.();
}
