// Resolves plugin-owned `channels add` CLI options from bundled and catalog metadata.
import { Option } from "commander";
import { listBundledPackageChannelMetadata } from "../../plugins/bundled-package-channel-metadata.js";
import type {
  PluginPackageChannel,
  PluginPackageChannelCliOption,
} from "../../plugins/manifest.js";
import { listRawChannelPluginCatalogEntries } from "./catalog.js";

export type ChannelSetupCliOptionValueMetadata = {
  longFlag: string;
  valueType: NonNullable<PluginPackageChannelCliOption["valueType"]>;
};

function compareChannels(left: PluginPackageChannel, right: PluginPackageChannel): number {
  const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;
  return leftOrder === rightOrder
    ? (left.id ?? "").localeCompare(right.id ?? "")
    : leftOrder - rightOrder;
}

export function resolveChannelSetupCliOptionMetadata(channelId?: string) {
  const bundledChannels = listBundledPackageChannelMetadata().toSorted(compareChannels);
  const catalogChannels = listRawChannelPluginCatalogEntries({
    excludeWorkspace: true,
    excludeOrigins: ["bundled"],
  })
    .flatMap((entry) => (entry.channel ? [entry.channel] : []))
    .toSorted(compareChannels);
  const channels = [...bundledChannels, ...catalogChannels];
  const seenFlags = new Set<string>();
  const options = channels
    .flatMap((channel) => channel.cliAddOptions ?? [])
    .filter((option) => !seenFlags.has(option.flags) && Boolean(seenFlags.add(option.flags)));
  const valueMetadataByAttributeName = new Map<string, ChannelSetupCliOptionValueMetadata>();
  const normalizedChannelId = channelId?.trim().toLowerCase();
  for (const channel of normalizedChannelId
    ? channels.filter(
        (candidate) =>
          candidate.id?.toLowerCase() === normalizedChannelId ||
          candidate.aliases?.some((alias) => alias.toLowerCase() === normalizedChannelId),
      )
    : []) {
    for (const option of channel.cliAddOptions ?? []) {
      if (!option.valueType) {
        continue;
      }
      const commanderOption = new Option(option.flags);
      valueMetadataByAttributeName.set(commanderOption.attributeName(), {
        longFlag: commanderOption.long ?? option.flags,
        valueType: option.valueType,
      });
    }
  }

  return { options, valueMetadataByAttributeName };
}
