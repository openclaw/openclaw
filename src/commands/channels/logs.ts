import fs from "node:fs/promises";
import { normalizeChannelId as normalizeBundledChannelId } from "../../channels/registry.js";
import { callGateway } from "../../gateway/call.js";
import { getResolvedLoggerSettings } from "../../logging.js";
import { resolveLogFile } from "../../logging/log-tail.js";
import { parseLogLine } from "../../logging/parse-log-line.js";
import { listManifestChannelContributionIds } from "../../plugins/manifest-contribution-ids.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { theme } from "../../terminal/theme.js";

export type ChannelsLogsOptions = {
  channel?: string;
  lines?: string | number;
  json?: boolean;
};

type LogLine = ReturnType<typeof parseLogLine>;
type LogsTailPayload = {
  file?: string;
  lines?: string[];
};

const DEFAULT_LIMIT = 200;
const MAX_BYTES = 1_000_000;

function listManifestChannelIds(): Set<string> {
  return new Set(
    listManifestChannelContributionIds({
      includeDisabled: true,
      env: process.env,
    }),
  );
}

function parseChannelFilter(raw?: string) {
  const trimmed = normalizeLowercaseStringOrEmpty(raw);
  if (!trimmed || trimmed === "all") {
    return "all";
  }
  const bundled = normalizeBundledChannelId(trimmed);
  if (bundled) {
    return bundled;
  }
  return listManifestChannelIds().has(trimmed) ? trimmed : "all";
}

function matchesChannel(line: NonNullable<LogLine>, channel: string) {
  if (channel === "all") {
    return true;
  }
  const channelLoggerNeedles = [`channels/${channel}`, `gateway/channels/${channel}`];
  if (line.subsystem && channelLoggerNeedles.some((needle) => line.subsystem?.includes(needle))) {
    return true;
  }
  if (line.module && channelLoggerNeedles.some((needle) => line.module?.includes(needle))) {
    return true;
  }
  if (line.module?.includes(channel)) {
    return true;
  }
  return false;
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

async function readGatewayTailLines(limit: number): Promise<{ file: string; rawLines: string[] }> {
  const fallbackFile = await resolveLogFile(getResolvedLoggerSettings().file);
  try {
    const payload = (await callGateway({
      method: "logs.tail",
      params: { limit, maxBytes: MAX_BYTES },
      timeoutMs: 10_000,
    })) as LogsTailPayload;
    if (payload && Array.isArray(payload.lines)) {
      return {
        file: typeof payload.file === "string" && payload.file ? payload.file : fallbackFile,
        rawLines: payload.lines,
      };
    }
  } catch {
    // Local fallback keeps this diagnostic command usable when the gateway RPC is unavailable.
  }
  return { file: fallbackFile, rawLines: await readTailLines(fallbackFile, limit) };
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

  const { file, rawLines } = await readGatewayTailLines(limit * 4);
  const parsed = rawLines
    .map(parseLogLine)
    .filter((line): line is NonNullable<LogLine> => Boolean(line));
  const filtered = parsed.filter((line) => matchesChannel(line, channel));
  const lines = filtered.slice(Math.max(0, filtered.length - limit));

  if (opts.json) {
    writeRuntimeJson(runtime, { file, channel, lines });
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
    const level = line.level ? `${normalizeLowercaseStringOrEmpty(line.level)} ` : "";
    runtime.log(`${ts}${level}${line.message}`.trim());
  }
}
