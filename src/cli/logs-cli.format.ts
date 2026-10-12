import { colorize, theme } from "../../packages/terminal-core/src/theme.js";
import { parseLogLine } from "../logging/parse-log-line.js";
import { formatTimestamp } from "../logging/timestamps.js";

function formatLogTimestamp(value?: string, mode: "pretty" | "plain" = "plain", localTime = true) {
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

export function formatLogsCliLine(
  raw: string,
  opts: {
    pretty: boolean;
    rich: boolean;
    localTime: boolean;
  },
): string {
  const parsed = parseLogLine(raw);
  if (!parsed) {
    return raw;
  }
  const label = parsed.subsystem ?? parsed.module ?? parsed.plugin ?? "";
  const time = formatLogTimestamp(parsed.time, opts.pretty ? "pretty" : "plain", opts.localTime);
  const level = parsed.level ?? "";
  const message = parsed.message || parsed.raw;

  if (!opts.pretty) {
    return [time, level, label, message].filter(Boolean).join(" ").trim();
  }

  const timeLabel = colorize(opts.rich, theme.muted, time);
  const labelValue = colorize(opts.rich, theme.accent, label);
  const levelStyle =
    level === "error" || level === "fatal"
      ? theme.error
      : level === "warn"
        ? theme.warn
        : level === "debug" || level === "trace"
          ? theme.muted
          : theme.info;
  const levelValue = colorize(opts.rich, levelStyle, level);
  const messageValue = colorize(opts.rich, levelStyle, message);

  const head = [timeLabel, levelValue, labelValue].filter(Boolean).join(" ");
  return [head, messageValue].filter(Boolean).join(" ").trim();
}
