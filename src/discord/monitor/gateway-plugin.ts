import { GatewayIntents, GatewayPlugin } from "@buape/carbon/gateway";
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import type { DiscordAccountConfig } from "../../config/types.js";
import { danger } from "../../globals.js";
import type { RuntimeEnv } from "../../runtime.js";

type GatewayPluginOptions = ConstructorParameters<typeof GatewayPlugin>[0];

export type ShutdownAwareGatewayPlugin = GatewayPlugin & {
  prepareForShutdown: () => void;
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
}): ShutdownAwareGatewayPlugin {
  const intents = resolveDiscordGatewayIntents(params.discordConfig?.intents);
  const proxy = params.discordConfig?.proxy?.trim();
  const options: GatewayPluginOptions = {
    reconnect: { maxAttempts: 50 },
    intents,
    autoInteractions: true,
  };

  class ManagedGatewayPlugin extends GatewayPlugin implements ShutdownAwareGatewayPlugin {
    private readonly proxyAgent?: HttpsProxyAgent<string>;
    private shuttingDown = false;

    constructor(proxyAgent?: HttpsProxyAgent<string>) {
      super(options);
      this.proxyAgent = proxyAgent;
    }

    prepareForShutdown() {
      this.shuttingDown = true;
    }

    override connect(resume = false) {
      this.shuttingDown = false;
      return super.connect(resume);
    }

    override createWebSocket(url: string) {
      if (!this.proxyAgent) {
        return super.createWebSocket(url);
      }
      return new WebSocket(url, { agent: this.proxyAgent });
    }

    override handleClose(code: number) {
      if (this.shuttingDown) {
        return;
      }
      super.handleClose(code);
    }

    override handleZombieConnection() {
      if (this.shuttingDown) {
        return;
      }
      super.handleZombieConnection();
    }

    override handleReconnect() {
      if (this.shuttingDown) {
        return;
      }
      super.handleReconnect();
    }
  }

  if (!proxy) {
    return new ManagedGatewayPlugin();
  }

  try {
    const agent = new HttpsProxyAgent<string>(proxy);

    params.runtime.log?.("discord: gateway proxy enabled");
    return new ManagedGatewayPlugin(agent);
  } catch (err) {
    params.runtime.error?.(danger(`discord: invalid gateway proxy: ${String(err)}`));
    return new ManagedGatewayPlugin();
  }
}
