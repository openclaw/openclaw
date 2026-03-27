import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "./bundled-channel-config-metadata.generated.js";
import type { ConfigUiHint } from "./schema.hints.js";

export type BundledChannelConfigMetadata = {
  pluginId: string;
  channelId: string;
  label?: string;
  description?: string;
  schema: Record<string, unknown>;
  uiHints?: Record<string, ConfigUiHint>;
};

export const BUNDLED_CHANNEL_CONFIG_METADATA =
  GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA as unknown as readonly BundledChannelConfigMetadata[];
