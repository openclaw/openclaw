import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { parseLogLine } from "../logging/parse-log-line.js";
import { formatTimestamp, isValidTimeZone } from "../logging/timestamps.js";
import { formatDocsLink } from "../terminal/links.js";
import { clearActiveProgressLine } from "../terminal/progress-line.js";
import { createSafeStreamWriter } from "../terminal/stream-writer.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

type LogsTailPayload = {
  file?: string;
  source?: "gateway" | "llm";
  cursor?: number;
  size?: number;
  lines?: string[];
  truncated?: boolean;
  reset?: boolean;
  hint?: string;
};

type LogsSource = "gateway" | "llm";
type LogsSourceOption = LogsSource | "all";

type LogsCliOptions = {
  limit?: string;
  maxBytes?: string;
  follow?: boolean;
  interval?: string;
  json?: boolean;
  plain?: boolean;
  color?: boolean;
  localTime?: boolean;
  source?: LogsSourceOption;
  url?: string;
  token?: string;
  timeout?: string;
  expectFinal?: boolean;
};

const DEFAULT_LOGS_MAX_BYTES = 1_000_000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchLogs(
  opts: LogsCliOptions,
  source: LogsSource,
  cursor: number | undefined,
  showProgress: boolean,
): Promise<LogsTailPayload> {
  const limit = parsePositiveInt(opts.limit, 200);
  const maxBytes = parsePositiveInt(opts.maxBytes, DEFAULT_LOGS_MAX_BYTES);
  const payload = await callGatewayFromCli(
    "logs.tail",
    opts,
    { cursor, limit, maxBytes, source },
    { progress: showProgress },
  );
  if (!payload || typeof payload !== "object") {
    throw new Error("Unexpected logs.tail response");
  }
  return payload as LogsTailPayload;
}

function resolveSources(source: LogsSourceOption | undefined): LogsSource[] {
  if (source === "all") {
    return ["gateway", "llm"];
  }
  return [source ?? "gateway"];
}

function parseSourceOption(source: string | undefined): LogsSourceOption {
  if (!source || source === "gateway" || source === "llm" || source === "all") {
    return (source ?? "gateway") as LogsSourceOption;
  }
  throw new Error(`Invalid --source value: ${source}. Expected gateway, llm, or all.`);
}

function toPublicSource(source: LogsSource | undefined): "gateway" | "llm" {
  return source === "gateway" ? "gateway" : "llm";
}

export function formatLogTimestamp(
  value?: string,
  mode: "pretty" | "plain" = "plain",
  localTime = false,
) {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  if (mode === "pretty") {
    return formatTimestamp(parsed, { style: "short", timeZone: localTime ? undefined : "UTC" });
  }
  return localTime ? formatTimestamp(parsed, { style: "long" }) : parsed.toISOString();
}

type DisplayLine = {
  time?: string;
  level?: string;
  label?: string;
  message: string;
};

type ParsedTraceLine = {
  raw: string;
  time?: string;
  level?: string;
  label: string;
  message: string;
  parsed: Record<string, unknown>;
};

function formatDisplayLine(
  line: DisplayLine,
  opts: {
    pretty: boolean;
    rich: boolean;
    localTime: boolean;
  },
): string {
  const time = formatLogTimestamp(line.time, opts.pretty ? "pretty" : "plain", opts.localTime);
  const level = line.level ?? "";
  const label = line.label ?? "";
  const levelLabel = level.padEnd(5).trim();

  if (!opts.pretty) {
    return [time, level, label, line.message].filter(Boolean).join(" ").trim();
  }

  const timeLabel = colorize(opts.rich, theme.muted, time);
  const labelValue = colorize(opts.rich, theme.accent, label);
  const levelValue =
    level === "error" || level === "fatal"
      ? colorize(opts.rich, theme.error, levelLabel)
      : level === "warn"
        ? colorize(opts.rich, theme.warn, levelLabel)
        : level === "debug" || level === "trace"
          ? colorize(opts.rich, theme.muted, levelLabel)
          : colorize(opts.rich, theme.info, levelLabel);
  const messageValue =
    level === "error" || level === "fatal"
      ? colorize(opts.rich, theme.error, line.message)
      : level === "warn"
        ? colorize(opts.rich, theme.warn, line.message)
        : level === "debug" || level === "trace"
          ? colorize(opts.rich, theme.muted, line.message)
          : colorize(opts.rich, theme.info, line.message);

  const head = [timeLabel, levelValue, labelValue].filter(Boolean).join(" ");
  return [head, messageValue].filter(Boolean).join(" ").trim();
}

function colorizeJsonScalar(value: string, rich: boolean): string {
  const match = value.match(/^(\s*)(.*?)(,?)(\s*)$/u);
  if (!match) {
    return value;
  }
  const [, leadingWhitespace, scalar, trailingComma, trailingWhitespace] = match;
  const trimmed = scalar.trim();

  let coloredScalar = scalar;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    coloredScalar = colorize(rich, theme.success, scalar);
  } else if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(trimmed)) {
    coloredScalar = colorize(rich, theme.warn, scalar);
  } else if (trimmed === "true" || trimmed === "false") {
    coloredScalar = colorize(rich, theme.accentBright, scalar);
  } else if (trimmed === "null") {
    coloredScalar = colorize(rich, theme.muted, scalar);
  }

  return `${leadingWhitespace}${coloredScalar}${trailingComma}${trailingWhitespace}`;
}

function colorizePrettyJsonBlock(text: string, rich: boolean): string {
  if (!rich) {
    return text;
  }
  return text
    .split("\n")
    .map((line) => {
      const keyMatch = line.match(/^(\s*)"((?:\\.|[^"\\])*)"(:\s*)(.*)$/u);
      if (keyMatch) {
        const [, indent, key, separator, rest] = keyMatch;
        const coloredKey = colorize(rich, theme.accentBright, `"${key}"`);
        const coloredRest = colorizeJsonScalar(rest, rich);
        return `${indent}${coloredKey}${separator}${coloredRest}`;
      }
      return colorizeJsonScalar(line, rich);
    })
    .join("\n");
}

export function formatPrettyJson(value: unknown, rich: boolean): string {
  try {
    return colorizePrettyJsonBlock(JSON.stringify(value, null, 2) ?? String(value), rich);
  } catch {
    return String(value);
  }
}

function parseTraceLine(raw: string): ParsedTraceLine | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.stage !== "string") {
      return null;
    }

    const provider =
      typeof parsed.provider === "string" && parsed.provider.trim().length > 0
        ? parsed.provider
        : undefined;
    const modelId =
      typeof parsed.modelId === "string" && parsed.modelId.trim().length > 0
        ? parsed.modelId
        : undefined;
    const label = provider ? `llm/${provider}` : "llm";

    const contextLabel = [provider, modelId].filter(Boolean).join("/");
    const parts = [parsed.stage];
    if (contextLabel) {
      parts.push(contextLabel);
    }
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      parts.push(`error=${parsed.error}`);
    }

    return {
      raw,
      time: typeof parsed.ts === "string" ? parsed.ts : undefined,
      level: typeof parsed.error === "string" ? "error" : "info",
      label,
      message: parts.join(" "),
      parsed,
    };
  } catch {
    return null;
  }
}

function createLogWriters() {
  const writer = createSafeStreamWriter({
    beforeWrite: () => clearActiveProgressLine(),
    onBrokenPipe: (err, stream) => {
      const code = err.code ?? "EPIPE";
      const target = stream === process.stdout ? "stdout" : "stderr";
      const message = `openclaw logs: output ${target} closed (${code}). Stopping tail.`;
      try {
        clearActiveProgressLine();
        process.stderr.write(`${message}\n`);
      } catch {
        // ignore secondary failures while reporting the broken pipe
      }
    },
  });

  return {
    logLine: (text: string) => writer.writeLine(process.stdout, text),
    errorLine: (text: string) => writer.writeLine(process.stderr, text),
    emitJsonLine: (payload: Record<string, unknown>, toStdErr = false) =>
      writer.write(toStdErr ? process.stderr : process.stdout, `${JSON.stringify(payload)}\n`),
  };
}

type ParsedOutputLine = {
  source: LogsSource;
  raw: string;
  rendered: string;
  jsonPayload?: Record<string, unknown>;
  sortTime?: number;
};

function parseSortTime(raw: string): number | undefined {
  const parsed = parseLogLine(raw);
  const timeCandidate = parsed?.time ?? parseTraceLine(raw)?.time;
  if (!timeCandidate) {
    return undefined;
  }
  const timestamp = new Date(timeCandidate).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function buildParsedOutputLine(
  raw: string,
  source: LogsSource,
  opts: {
    pretty: boolean;
    rich: boolean;
    localTime: boolean;
  },
): ParsedOutputLine {
  const parsed = parseLogLine(raw);
  if (
    parsed &&
    (parsed.time || parsed.level || parsed.subsystem || parsed.module || parsed.message.trim())
  ) {
    return {
      source,
      raw,
      rendered: formatDisplayLine(
        {
          time: parsed.time,
          level: parsed.level,
          label: parsed.subsystem ?? parsed.module,
          message: parsed.message || parsed.raw,
        },
        opts,
      ),
      jsonPayload: { type: "log", source: toPublicSource(source), ...parsed },
      sortTime: parseSortTime(raw),
    };
  }

  const trace = parseTraceLine(raw);
  if (trace) {
    const heading = formatDisplayLine(
      {
        time: trace.time,
        level: trace.level,
        label: trace.label,
        message: trace.message,
      },
      opts,
    );
    return {
      source,
      raw,
      rendered: `${heading}\n${formatPrettyJson(trace.parsed, opts.rich)}\n`,
      jsonPayload: { type: "trace", source: toPublicSource(source), ...trace },
      sortTime: parseSortTime(raw),
    };
  }

  return {
    source,
    raw,
    rendered: raw,
    jsonPayload: { type: "raw", source: toPublicSource(source), raw },
    sortTime: undefined,
  };
}

function sortOutputLines(lines: ParsedOutputLine[]): ParsedOutputLine[] {
  return [...lines].toSorted((a, b) => {
    const aTime = a.sortTime;
    const bTime = b.sortTime;
    if (aTime != null && bTime != null && aTime !== bTime) {
      return aTime - bTime;
    }
    if (aTime != null && bTime == null) {
      return -1;
    }
    if (aTime == null && bTime != null) {
      return 1;
    }
    return 0;
  });
}

function getTruncatedNotice(payload: LogsTailPayload): string {
  if (payload.source === "llm" && Array.isArray(payload.lines) && payload.lines.length === 0) {
    return "Log tail truncated before a full trace line was captured. Retry with a larger --max-bytes value.";
  }
  return "Showing only the most recent log tail; older lines were omitted. Increase --max-bytes for more history.";
}

function shouldReportTruncation(payload: LogsTailPayload): boolean {
  if (!payload.truncated) {
    return false;
  }
  if (payload.source === "llm" && Array.isArray(payload.lines) && payload.lines.length > 0) {
    // Trace files are tailed from the end on purpose; avoid noisy notices when
    // we already captured the newest complete events.
    return false;
  }
  return true;
}

function formatSourceNotice(source: LogsSource | undefined, message: string): string {
  const prefix = toPublicSource(source);
  return `${prefix}: ${message}`;
}

function emitGatewayError(
  err: unknown,
  opts: LogsCliOptions,
  mode: "json" | "text",
  rich: boolean,
  emitJsonLine: (payload: Record<string, unknown>, toStdErr?: boolean) => boolean,
  errorLine: (text: string) => boolean,
) {
  const details = buildGatewayConnectionDetails({ url: opts.url });
  const message = "Gateway not reachable. Is it running and accessible?";
  const hint = `Hint: run \`${formatCliCommand("openclaw doctor")}\`.`;
  const errorText = err instanceof Error ? err.message : String(err);

  if (mode === "json") {
    if (
      !emitJsonLine(
        {
          type: "error",
          message,
          error: errorText,
          details,
          hint,
        },
        true,
      )
    ) {
      return;
    }
    return;
  }

  if (!errorLine(colorize(rich, theme.error, message))) {
    return;
  }
  if (!errorLine(details.message)) {
    return;
  }
  errorLine(colorize(rich, theme.muted, hint));
}

export function registerLogsCli(program: Command) {
  const logs = program
    .command("logs")
    .description("Tail gateway file logs via RPC")
    .option("--limit <n>", "Max lines to return", "200")
    .option("--max-bytes <n>", "Max bytes to read", String(DEFAULT_LOGS_MAX_BYTES))
    .option("--follow", "Follow log output", false)
    .option("--interval <ms>", "Polling interval in ms", "1000")
    .option("--json", "Emit JSON log lines", false)
    .option("--plain", "Plain text output (no ANSI styling)", false)
    .option("--no-color", "Disable ANSI colors")
    .option("--local-time", "Display timestamps in local timezone", false)
    .option("--source <source>", "Log source: gateway, llm, or all", "gateway")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/logs", "docs.openclaw.ai/cli/logs")}\n`,
    );

  addGatewayClientOptions(logs);

  logs.action(async (opts: LogsCliOptions) => {
    const { logLine, errorLine, emitJsonLine } = createLogWriters();
    const interval = parsePositiveInt(opts.interval, 1000);
    let first = true;
    const jsonMode = Boolean(opts.json);
    const pretty = !jsonMode && Boolean(process.stdout.isTTY) && !opts.plain;
    const rich = isRich() && opts.color !== false;
    const localTime =
      Boolean(opts.localTime) || (!!process.env.TZ && isValidTimeZone(process.env.TZ));
    const sourceOption = parseSourceOption(opts.source);
    const sources = resolveSources(sourceOption);
    const cursors = new Map<LogsSource, number | undefined>();

    while (true) {
      try {
        const payloads = await Promise.all(
          sources.map(async (source, index) => {
            const showProgress = first && !opts.follow && index === 0;
            const payload = await fetchLogs(opts, source, cursors.get(source), showProgress);
            return { source, payload };
          }),
        );
        if (jsonMode) {
          if (first) {
            for (const { payload } of payloads) {
              if (
                !emitJsonLine({
                  type: "meta",
                  file: payload.file,
                  source: toPublicSource(payload.source),
                  cursor: payload.cursor,
                  size: payload.size,
                })
              ) {
                return;
              }
            }
          }

          const mergedLines = sortOutputLines(
            payloads.flatMap(({ source, payload }) =>
              (Array.isArray(payload.lines) ? payload.lines : []).map((line) =>
                buildParsedOutputLine(line, source, { pretty, rich, localTime }),
              ),
            ),
          );
          for (const line of mergedLines) {
            if (
              !emitJsonLine(
                line.jsonPayload ?? {
                  type: "raw",
                  source: toPublicSource(line.source),
                  raw: line.raw,
                },
              )
            ) {
              return;
            }
          }

          if (first) {
            for (const { payload } of payloads) {
              if (payload.hint) {
                if (
                  !emitJsonLine({
                    type: "hint",
                    source: toPublicSource(payload.source),
                    message: payload.hint,
                  })
                ) {
                  return;
                }
              }
            }
          }

          for (const { payload } of payloads) {
            if (payload.truncated) {
              if (!shouldReportTruncation(payload)) {
                continue;
              }
              if (
                !emitJsonLine({
                  type: "notice",
                  source: toPublicSource(payload.source),
                  message: getTruncatedNotice(payload),
                })
              ) {
                return;
              }
            }
            if (payload.reset) {
              if (
                !emitJsonLine({
                  type: "notice",
                  source: toPublicSource(payload.source),
                  message: "Log cursor reset (file rotated).",
                })
              ) {
                return;
              }
            }
          }
        } else {
          if (first) {
            for (const { payload } of payloads) {
              if (!payload.file) {
                continue;
              }
              const prefix = pretty ? colorize(rich, theme.muted, "Log file:") : "Log file:";
              const suffix =
                toPublicSource(payload.source) !== "gateway"
                  ? ` (${toPublicSource(payload.source)})`
                  : "";
              if (!logLine(`${prefix} ${payload.file}${suffix}`)) {
                return;
              }
            }
          }

          const mergedLines = sortOutputLines(
            payloads.flatMap(({ source, payload }) =>
              (Array.isArray(payload.lines) ? payload.lines : []).map((line) =>
                buildParsedOutputLine(line, source, { pretty, rich, localTime }),
              ),
            ),
          );
          for (const line of mergedLines) {
            if (!logLine(line.rendered)) {
              return;
            }
          }

          if (first) {
            for (const { payload } of payloads) {
              if (payload.hint) {
                if (!errorLine(formatSourceNotice(payload.source, payload.hint))) {
                  return;
                }
              }
            }
          }

          for (const { payload } of payloads) {
            if (payload.truncated) {
              if (!shouldReportTruncation(payload)) {
                continue;
              }
              if (!errorLine(formatSourceNotice(payload.source, getTruncatedNotice(payload)))) {
                return;
              }
            }
            if (payload.reset) {
              if (
                !errorLine(formatSourceNotice(payload.source, "Log cursor reset (file rotated)."))
              ) {
                return;
              }
            }
          }
        }

        for (const { source, payload } of payloads) {
          const nextCursor =
            typeof payload.cursor === "number" && Number.isFinite(payload.cursor)
              ? payload.cursor
              : cursors.get(source);
          cursors.set(source, nextCursor);
        }
      } catch (err) {
        emitGatewayError(err, opts, jsonMode ? "json" : "text", rich, emitJsonLine, errorLine);
        process.exit(1);
        return;
      }
      first = false;

      if (!opts.follow) {
        return;
      }
      await delay(interval);
    }
  });
}
