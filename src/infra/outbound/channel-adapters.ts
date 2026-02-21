import { Separator, TextDisplay, type TopLevelComponents } from "@buape/carbon";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { DiscordUiContainer } from "../../discord/ui.js";

export type CrossContextComponentsBuilder = (message: string) => TopLevelComponents[];

export type CrossContextComponentsFactory = (params: {
  originLabel: string;
  message: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
}) => TopLevelComponents[];

export type ChannelMessageAdapter = {
  supportsComponentsV2: boolean;
  buildCrossContextComponents?: CrossContextComponentsFactory;
};

type CrossContextContainerParams = {
  originLabel: string;
  message: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
};

class CrossContextContainer extends DiscordUiContainer {
  constructor({ originLabel, message, cfg, accountId }: CrossContextContainerParams) {
    const trimmed = message.trim();
    const components = [] as Array<TextDisplay | Separator>;
    if (trimmed) {
      components.push(new TextDisplay(message));
      components.push(new Separator({ divider: true, spacing: "small" }));
    }
    components.push(new TextDisplay(`*From ${originLabel}*`));
    super({ cfg, accountId, components });
  }
}

const DEFAULT_ADAPTER: ChannelMessageAdapter = {
  supportsComponentsV2: false,
};

const DISCORD_ADAPTER: ChannelMessageAdapter = {
  supportsComponentsV2: true,
  buildCrossContextComponents: ({ originLabel, message, cfg, accountId }) => [
    new CrossContextContainer({ originLabel, message, cfg, accountId }),
  ],
};

export function getChannelMessageAdapter(channel: ChannelId): ChannelMessageAdapter {
  if (channel === "discord") {
    return DISCORD_ADAPTER;
  }
  return DEFAULT_ADAPTER;
}
