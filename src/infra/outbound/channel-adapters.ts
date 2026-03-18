import type { TopLevelComponents } from "@buape/carbon";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";

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

const DEFAULT_ADAPTER: ChannelMessageAdapter = {
  supportsComponentsV2: false,
};

export function getChannelMessageAdapter(channel: ChannelId): ChannelMessageAdapter {
  const adapter = getChannelPlugin(channel)?.messaging?.buildCrossContextComponents;
  if (adapter) {
    return {
      supportsComponentsV2: true,
      buildCrossContextComponents: adapter,
    };
  }
  return DEFAULT_ADAPTER;
}
