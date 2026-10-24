import { setTimeout as delay } from "node:timers/promises";
import { resolvePositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { createSafeStreamWriter } from "../../../packages/terminal-core/src/stream-writer.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  CHAT_CHANNEL_ORDER,
  normalizeChatChannelId as normalizeBundledChannelId,
} from "../../channels/registry.js";
import { parseLogsPositiveInt } from "../../cli/logs-cli.options.js";
import { readConfiguredParsedLogTail } from "../../logging/log-tail.js";
import type { ParsedLogLine } from "../../logging/parse-log-line.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../../plugins/plugin-registry.js";
import { defaultRuntime } from "../../runtime.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";

const DEFAULT_LIMIT = 200;
const MAX_BYTES = 1_000_000;

function matchesChannelContext(value: string | undefined, channel: string) {
  return [channel, `channels/${channel}`, `gateway/channels/${channel}`].some(
    (root) => value === root || value?.startsWith(`${root}/`) === true,
  );
}

function formatChannelLogLine(line: ParsedLogLine) {
  const ts = line.time ? `${line.time} ` : "";
  const level = line.level ? `${normalizeLowercaseStringOrEmpty(line.level)} ` : "";
  return `${ts}${level}${line.message}`.trim();
}

/** Print or serialize recent log lines matching one channel subsystem/module. */
export async function channelsLogsCommand(opts: {
  channel?: string;
  lines?: string | number;
  json?: boolean;
  follow?: boolean;
  interval?: string | number;
}) {
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

  const readTail = (cursor?: number, lineLimit = limit) =>
    readConfiguredParsedLogTail({
      cursor,
      limit: lineLimit,
      maxBytes: MAX_BYTES,
      filter: (line) =>
        channel === "all" ||
        [line.subsystem, line.module].some((value) => matchesChannelContext(value, channel)) ||
        (line.plugin !== undefined && pluginIds.has(line.plugin)),
    });
  const interval = opts.follow
    ? resolvePositiveTimerTimeoutMs(parseLogsPositiveInt(opts.interval, 1000, "--interval"), 1000)
    : 1000;
  let tail = await readTail();

  if (opts.follow) {
    const signal = getAsyncWorkSignal();
    const writer = createSafeStreamWriter();
    const write = (text: string) => writer.writeLine(process.stdout, text);
    const jsonLine = (value: Record<string, unknown>) => write(JSON.stringify(value));
    const notice = (message: string) =>
      opts.json ? jsonLine({ type: "notice", message }) : write(theme.warn(message));
    let previousFile: string | undefined;
    try {
      for (;;) {
        if (signal?.aborted) {
          break;
        }
        const sourceChanged = previousFile !== undefined && tail.file !== previousFile;
        if (previousFile === undefined || sourceChanged) {
          if (opts.json) {
            if (!jsonLine({ type: "meta", file: tail.file, channel })) {
              return;
            }
          } else if (
            !write(theme.info(`Log file: ${tail.file}`)) ||
            (channel !== "all" && !write(theme.info(`Channel: ${channel}`)))
          ) {
            return;
          }
        }
        if (tail.reset || sourceChanged) {
          const message = tail.skippedBytes
            ? `Log cursor re-anchored (skipped ${tail.skippedBytes} bytes).`
            : "Log cursor reset (file rotated or shrank).";
          if (!notice(message)) {
            return;
          }
        }
        if (tail.truncated && !notice("Log tail truncated; earlier entries were omitted.")) {
          return;
        }
        for (const line of tail.lines) {
          const written = opts.json
            ? jsonLine({ type: "log", ...line })
            : write(formatChannelLogLine(line));
          if (!written) {
            return;
          }
        }
        previousFile = tail.file;
        await delay(interval, undefined, { signal });
        if (signal?.aborted) {
          return;
        }
        // --lines bounds the initial snapshot, not each subsequent append batch.
        const next = await readTail(tail.cursor, 5000);
        // Byte cursors belong to one file, including across daily rolling paths.
        tail = next.file === tail.file ? next : await readTail(undefined, 5000);
      }
    } catch (error) {
      if (!signal?.aborted) {
        throw error;
      }
      // The CLI lifetime owner records the signal exit status after cleanup.
    }
    return;
  }
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
    defaultRuntime.log(formatChannelLogLine(line));
  }
}
