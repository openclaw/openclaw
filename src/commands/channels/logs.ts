import fs from "node:fs/promises";
import path from "node:path";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import { LOG_PREFIX, LOG_SUFFIX } from "../../logging/logger.js";
import { getResolvedLoggerSettings } from "../../logging.js";
import { parseLogLine } from "../../logging/parse-log-line.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";

export type ChannelsLogsOptions = {
  channel?: string;
  lines?: string | number;
  json?: boolean;
};

type LogLine = ReturnType<typeof parseLogLine>;

const DEFAULT_LIMIT = 200;
const MAX_BYTES = 1_000_000;

const getChannelSet = () =>
  new Set<string>([...listChannelPlugins().map((plugin) => plugin.id), "all"]);

function parseChannelFilter(raw?: string) {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) {
    return "all";
  }
  return getChannelSet().has(trimmed) ? trimmed : "all";
}

function matchesChannel(line: NonNullable<LogLine>, channel: string) {
  if (channel === "all") {
    return true;
  }
  const needle = `gateway/channels/${channel}`;
  if (line.subsystem?.includes(needle)) {
    return true;
  }
  if (line.module?.includes(channel)) {
    return true;
  }
  return false;
}

/**
 * Find the active log file to read.
 * First tries today's log file, then falls back to the most recently modified log file.
 */
async function findActiveLogFile(): Promise<string> {
  const configuredFile = getResolvedLoggerSettings().file;
  const logDir = path.dirname(configuredFile);

  try {
    await fs.access(configuredFile);
    return configuredFile;
  } catch {
    // Today's log doesn't exist, find the most recently modified log file
    // Use the configured log directory, not DEFAULT_LOG_DIR
    const entries = await fs.readdir(logDir).catch(() => []);
    const logFiles = entries
      .filter((name) => name.startsWith(`${LOG_PREFIX}-`) && name.endsWith(LOG_SUFFIX));
    // Don't slice before sorting - we need to check all files to find the newest

    if (logFiles.length === 0) {
      return configuredFile; // Fallback to default
    }

    // Sort by modification time, newest first
    const filesWithMtime = await Promise.all(
      logFiles.map(async (name) => {
        const filePath = path.join(logDir, name);
        const stat = await fs.stat(filePath).catch(() => null);
        return { name, mtime: stat?.mtime?.getTime() ?? 0 };
      }),
    );
    filesWithMtime.sort((a, b) => b.mtime - a.mtime);

    return path.join(logDir, filesWithMtime[0].name);
  }
}

async function readTailLines(file: string, limit: number): Promise<string[]> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) {
    return [];
  }
  const size = stat.size;
  const start = Math.max(0, size - MAX_BYTES);
  const handle = await fs.open(file, "r");
  try {
    const length = Math.max(0, size - start);
    if (length === 0) {
      return [];
    }
    const buffer = Buffer.alloc(length);
    const readResult = await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8", 0, readResult.bytesRead);
    let lines = text.split("\n");
    if (start > 0) {
      lines = lines.slice(1);
    }
    if (lines.length && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
    if (lines.length > limit) {
      lines = lines.slice(lines.length - limit);
    }
    return lines;
  } finally {
    await handle.close();
  }
}

export async function channelsLogsCommand(
  opts: ChannelsLogsOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const channel = parseChannelFilter(opts.channel);
  const limitRaw = typeof opts.lines === "string" ? Number(opts.lines) : opts.lines;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : DEFAULT_LIMIT;

  const file = await findActiveLogFile();
  const rawLines = await readTailLines(file, limit * 4);
  const parsed = rawLines
    .map(parseLogLine)
    .filter((line): line is NonNullable<LogLine> => Boolean(line));
  const filtered = parsed.filter((line) => matchesChannel(line, channel));
  const lines = filtered.slice(Math.max(0, filtered.length - limit));

  if (opts.json) {
    runtime.log(JSON.stringify({ file, channel, lines }, null, 2));
    return;
  }

  runtime.log(theme.info(`Log file: ${file}`));
  if (channel !== "all") {
    runtime.log(theme.info(`Channel: ${channel}`));
  }
  if (lines.length === 0) {
    runtime.log(theme.muted("No matching log lines."));
    return;
  }
  for (const line of lines) {
    const ts = line.time ? `${line.time} ` : "";
    const level = line.level ? `${line.level.toLowerCase()} ` : "";
    runtime.log(`${ts}${level}${line.message}`.trim());
  }
}
