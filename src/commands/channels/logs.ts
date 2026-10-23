import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  CHAT_CHANNEL_ORDER,
  normalizeChatChannelId as normalizeBundledChannelId,
} from "../../channels/registry.js";
import { parseLogsPositiveInt } from "../../cli/logs-cli.options.js";
import { readConfiguredParsedLogTail } from "../../logging/log-tail.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../../plugins/plugin-registry.js";
import { defaultRuntime } from "../../runtime.js";

type ChannelsLogsOptions = {
  channel?: string;
  lines?: string | number;
  json?: boolean;
};

const DEFAULT_LIMIT = 200;
const MAX_BYTES = 1_000_000;

function matchesChannelContext(value: string | undefined, channel: string) {
  return [channel, `channels/${channel}`, `gateway/channels/${channel}`].some(
    (root) => value === root || value?.startsWith(`${root}/`) === true,
  );
}

/** Print or serialize recent log lines matching one channel subsystem/module. */
export async function channelsLogsCommand(opts: ChannelsLogsOptions) {
  let channel = opts.channel === undefined ? "all" : normalizeLowercaseStringOrEmpty(opts.channel);
  const pluginIds = new Set<string>();
  if (channel !== "all") {
    const manifestChannels = loadPluginManifestRegistryForPluginRegistry({
      includeDisabled: true,
      env: process.env,
    }).plugins.flatMap((plugin) =>
      plugin.channels.flatMap((rawChannel) => {
        const id = normalizeLowercaseStringOrEmpty(rawChannel);
        return id ? [{ id, pluginId: plugin.id }] : [];
      }),
    );
    const bundled = normalizeBundledChannelId(channel);
    channel = bundled ?? channel;
    for (const entry of manifestChannels) {
      if (entry.id === channel) {
        pluginIds.add(entry.pluginId);
      }
    }
    if (!bundled && pluginIds.size === 0) {
      const manifestIds = [...new Set(manifestChannels.map((entry) => entry.id))].toSorted();
      const validChannels = ["all", ...new Set([...CHAT_CHANNEL_ORDER, ...manifestIds])];
      throw new Error(
        `Unknown channel ${JSON.stringify(opts.channel)}. Valid channels: ${validChannels.join(", ")}`,
      );
    }
  }
  const limit = parseLogsPositiveInt(opts.lines, DEFAULT_LIMIT, "--lines");

  const tail = await readConfiguredParsedLogTail({
    limit,
    maxBytes: MAX_BYTES,
    filter: (line) =>
      channel === "all" ||
      [line.subsystem, line.module].some((value) => matchesChannelContext(value, channel)) ||
      (line.plugin !== undefined && pluginIds.has(line.plugin)),
  });
  const { lines, truncated } = tail;

  if (opts.json) {
    defaultRuntime.writeJson({ file: tail.file, channel, truncated, lines });
    return;
  }

  defaultRuntime.log(theme.info(`Log file: ${tail.file}`));
  if (channel !== "all") {
    defaultRuntime.log(theme.info(`Channel: ${channel}`));
  }
  if (truncated) {
    defaultRuntime.log(theme.warn("Log tail truncated; earlier entries were omitted."));
  }
  if (lines.length === 0) {
    defaultRuntime.log(theme.muted("No matching log lines."));
    return;
  }
  for (const line of lines) {
    const ts = line.time ? `${line.time} ` : "";
    const level = line.level ? `${normalizeLowercaseStringOrEmpty(line.level)} ` : "";
    defaultRuntime.log(`${ts}${level}${line.message}`.trim());
  }
}
