import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import {
  buildGatewayConnectionDetails,
  isGatewayTransportError,
  type GatewayConnectionDetails,
} from "../gateway/call.js";
import { isLoopbackHost } from "../gateway/net.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import { readConnectPairingRequiredMessage } from "../gateway/protocol/connect-error-details.js";
import { computeBackoff } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readConfiguredLogTail } from "../logging/log-tail.js";
import { parseLogLine } from "../logging/parse-log-line.js";
import { formatTimestamp, isValidTimeZone } from "../logging/timestamps.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { formatDocsLink } from "../terminal/links.js";
import { clearActiveProgressLine } from "../terminal/progress-line.js";
import { createSafeStreamWriter } from "../terminal/stream-writer.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

type LogsCliRuntimeModule = typeof import("./logs-cli.runtime.js");

const logsCliRuntimeLoader = createLazyImportLoader<LogsCliRuntimeModule>(
  () => import("./logs-cli.runtime.js"),
);

async function loadLogsCliRuntime(): Promise<LogsCliRuntimeModule> {
  return logsCliRuntimeLoader.load();
}

type LogsTailPayload = {
  file?: string;
  source?: string;
  sourceKind?: "file" | "journal";
  service?: {
    pid?: number;
    execStart?: string;
  };
  cursor?: LogCursor;
  size?: number;
  lines?: string[];
  truncated?: boolean;
  reset?: boolean;
  localFallback?: boolean;
};

type LogCursor = number | string;

type LogsCliOptions = {
  limit?: string;
  maxBytes?: string;
  follow?: boolean;
  interval?: string;
  json?: boolean;
  plain?: boolean;
  color?: boolean;
  localTime?: boolean;
  url?: string;
  token?: string;
  timeout?: string;
  expectFinal?: boolean;
};

const LOCAL_FALLBACK_NOTICE = "Local Gateway RPC unavailable; reading configured file log instead.";
const JOURNAL_FALLBACK_NOTICE =
  "Local Gateway RPC unavailable; reading active systemd gateway journal instead.";
const JOURNAL_CURSOR_PREFIX = "-- cursor: ";
const SENSITIVE_EXEC_ARG_NAMES = new Set([
  "--api-key",
  "--apikey",
  "--auth",
  "--client-secret",
  "--key",
  "--password",
  "--secret",
  "--token",
]);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchLogs(
  opts: LogsCliOptions,
  cursor: LogCursor | undefined,
  showProgress: boolean,
): Promise<LogsTailPayload> {
  const limit = parsePositiveInt(opts.limit, 200);
  const maxBytes = parsePositiveInt(opts.maxBytes, 250_000);
  const gatewayCursor = typeof cursor === "number" ? cursor : undefined;
  try {
    const payload = await callGatewayFromCli(
      "logs.tail",
      opts,
      { cursor: gatewayCursor, limit, maxBytes },
      buildLogsTailGatewayExtra(opts, showProgress),
    );
    if (!payload || typeof payload !== "object") {
      throw new Error("Unexpected logs.tail response");
    }
    return payload as LogsTailPayload;
  } catch (error) {
    if (!shouldUseLocalLogsFallback(opts, error)) {
      throw error;
    }
    if (opts.follow) {
      const journalPayload = await readSystemdJournalFallback({ cursor, limit, maxBytes });
      if (journalPayload) {
        return journalPayload;
      }
      throw error;
    }
    // Match the Gateway logs.tail source when implicit local RPC is unavailable.
    return {
      ...(await readConfiguredLogTail({ cursor: gatewayCursor, limit, maxBytes })),
      sourceKind: "file",
      localFallback: true,
    };
  }
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function shouldUseLocalLogsFallback(opts: LogsCliOptions, error: unknown): boolean {
  if (!isLocalGatewayRpcUnavailableError(error)) {
    return false;
  }
  if (typeof opts.url === "string" && opts.url.trim().length > 0) {
    return false;
  }
  const connection = isGatewayTransportError(error)
    ? error.connectionDetails
    : buildGatewayConnectionDetails();
  return isImplicitLoopbackGatewayConnection(connection);
}

function buildLogsTailGatewayExtra(opts: LogsCliOptions, showProgress: boolean) {
  const base = { progress: showProgress };
  if (!shouldUsePassiveLocalLogsClient(opts)) {
    return base;
  }
  return {
    ...base,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    deviceIdentity: null,
  };
}

function shouldUsePassiveLocalLogsClient(opts: LogsCliOptions): boolean {
  if (typeof opts.url === "string" && opts.url.trim().length > 0) {
    return false;
  }
  return isImplicitLoopbackGatewayConnection(buildGatewayConnectionDetails());
}

function isImplicitLoopbackGatewayConnection(connection: GatewayConnectionDetails): boolean {
  if (connection.urlSource !== "local loopback") {
    return false;
  }
  try {
    return isLoopbackHost(new URL(connection.url).hostname);
  } catch {
    return false;
  }
}

function isLocalGatewayRpcUnavailableError(error: unknown): boolean {
  if (isGatewayTransportError(error)) {
    return error.kind === "closed" || error.kind === "timeout";
  }
  const message = normalizeLowercaseStringOrEmpty(normalizeErrorMessage(error));
  if (readConnectPairingRequiredMessage(message)) {
    return true;
  }
  // GatewayClient pending request failures are still plain Error instances.
  return isPlainGatewayRequestCloseError(message) || isPlainGatewayRequestTimeoutError(message);
}

function isPlainGatewayRequestCloseError(message: string): boolean {
  return message.startsWith("gateway closed (");
}

function isPlainGatewayRequestTimeoutError(message: string): boolean {
  return /^gateway timeout after \d+ms\b/u.test(message);
}

async function readSystemdJournalFallback(params: {
  cursor: LogCursor | undefined;
  limit: number;
  maxBytes: number;
}): Promise<LogsTailPayload | null> {
  if (process.platform !== "linux") {
    return null;
  }
  const runtime = await loadLogsCliRuntime();
  const service = await runtime.readSystemdServiceRuntime(process.env);
  if (service.status !== "running" || typeof service.pid !== "number") {
    return null;
  }
  const serviceCommand = await runtime.readSystemdServiceExecStart(process.env).catch(() => null);
  const source = `journalctl --user _PID=${service.pid}`;
  const args = [
    "--user",
    `_PID=${service.pid}`,
    "--no-pager",
    "--output=cat",
    "--show-cursor",
  ];
  if (typeof params.cursor === "string" && params.cursor.trim().length > 0) {
    args.push(`--after-cursor=${params.cursor}`);
  } else {
    args.push("-n", String(params.limit));
  }
  const result = await runtime.execFileUtf8("journalctl", args, {
    env: process.env,
    maxBuffer: Math.max(params.maxBytes * 2, 1024 * 1024),
  });
  if (result.code !== 0) {
    return null;
  }
  const parsed = parseJournalctlOutput(result.stdout);
  return {
    source,
    sourceKind: "journal",
    service: {
      pid: service.pid,
      ...(serviceCommand
        ? { execStart: formatServiceExecStart(serviceCommand.programArguments) }
        : {}),
    },
    cursor: parsed.cursor ?? params.cursor,
    lines: parsed.lines,
    localFallback: true,
  };
}

function parseJournalctlOutput(output: string): { lines: string[]; cursor?: string } {
  const lines: string[] = [];
  let cursor: string | undefined;
  for (const rawLine of output.split(/\r?\n/u)) {
    if (!rawLine) {
      continue;
    }
    if (rawLine.startsWith(JOURNAL_CURSOR_PREFIX)) {
      cursor = rawLine.slice(JOURNAL_CURSOR_PREFIX.length).trim() || cursor;
      continue;
    }
    lines.push(rawLine);
  }
  return { lines, cursor };
}

function formatServiceExecStart(args: readonly string[]): string {
  const rendered: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      rendered.push("[redacted]");
      redactNext = false;
      continue;
    }
    const [name, value] = splitInlineArg(arg);
    if (isSensitiveExecArgName(name)) {
      if (value === undefined) {
        rendered.push(name);
        redactNext = true;
      } else {
        rendered.push(`${name}=[redacted]`);
      }
      continue;
    }
    rendered.push(renderShellArg(arg));
  }
  return rendered.join(" ");
}

function isSensitiveExecArgName(name: string): boolean {
  if (SENSITIVE_EXEC_ARG_NAMES.has(name)) {
    return true;
  }
  const normalized = normalizeLowercaseStringOrEmpty(name);
  return (
    normalized.includes("api-key") ||
    normalized.includes("apikey") ||
    normalized.includes("auth") ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.includes("token")
  );
}

function splitInlineArg(arg: string): [string, string | undefined] {
  const index = arg.indexOf("=");
  if (index <= 0) {
    return [arg, undefined];
  }
  return [arg.slice(0, index), arg.slice(index + 1)];
}

function renderShellArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/u.test(arg)) {
    return arg;
  }
  return JSON.stringify(arg);
}

const MAX_FOLLOW_RETRIES = 8;

const FOLLOW_BACKOFF_POLICY = { initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: 0.2 };

// Returns true only for transport-level disconnects that are worth retrying.
// Auth errors (4xxx), policy violations (1008), and pairing-required messages are
// non-recoverable without user action and must not loop.
function isTransientFollowError(error: unknown): boolean {
  if (isGatewayTransportError(error)) {
    if (error.kind === "timeout") {
      return true;
    }
    const code = error.code ?? 0;
    // 1008 = policy violation (pairing required); 4xxx = app-defined (auth, rate-limit)
    return code !== 1008 && !(code >= 4000 && code <= 4999);
  }
  const message = normalizeLowercaseStringOrEmpty(normalizeErrorMessage(error));
  if (readConnectPairingRequiredMessage(message)) {
    return false;
  }
  return isPlainGatewayRequestCloseError(message) || isPlainGatewayRequestTimeoutError(message);
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

function formatLogLine(
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
  const label = parsed.subsystem ?? parsed.module ?? "";
  const time = formatLogTimestamp(parsed.time, opts.pretty ? "pretty" : "plain", opts.localTime);
  const level = parsed.level ?? "";
  const levelLabel = level.padEnd(5).trim();
  const message = parsed.message || parsed.raw;

  if (!opts.pretty) {
    return [time, level, label, message].filter(Boolean).join(" ").trim();
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
      ? colorize(opts.rich, theme.error, message)
      : level === "warn"
        ? colorize(opts.rich, theme.warn, message)
        : level === "debug" || level === "trace"
          ? colorize(opts.rich, theme.muted, message)
          : colorize(opts.rich, theme.info, message);

  const head = [timeLabel, levelValue, labelValue].filter(Boolean).join(" ");
  return [head, messageValue].filter(Boolean).join(" ").trim();
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

async function emitGatewayError(
  err: unknown,
  opts: LogsCliOptions,
  mode: "json" | "text",
  rich: boolean,
  emitJsonLine: (payload: Record<string, unknown>, toStdErr?: boolean) => boolean,
  errorLine: (text: string) => boolean,
) {
  const runtime = await loadLogsCliRuntime();
  const message = "Gateway not reachable. Is it running and accessible?";
  const hint = `Hint: run \`${formatCliCommand("openclaw doctor")}\`.`;
  const errorText = formatErrorMessage(err);

  const details = runtime.buildGatewayConnectionDetails({ url: opts.url });
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
    .option("--max-bytes <n>", "Max bytes to read", "250000")
    .option("--follow", "Follow log output", false)
    .option("--interval <ms>", "Polling interval in ms", "1000")
    .option("--json", "Emit JSON log lines", false)
    .option("--plain", "Plain text output (no ANSI styling)", false)
    .option("--no-color", "Disable ANSI colors")
    .option("--local-time", "Display timestamps in local timezone", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/logs", "docs.openclaw.ai/cli/logs")}\n`,
    );

  addGatewayClientOptions(logs);

  logs.action(async (opts: LogsCliOptions) => {
    const { logLine, errorLine, emitJsonLine } = createLogWriters();
    const interval = parsePositiveInt(opts.interval, 1000);
    let cursor: LogCursor | undefined;
    let first = true;
    const jsonMode = Boolean(opts.json);
    const pretty = !jsonMode && process.stdout.isTTY && !opts.plain;
    const rich = isRich() && opts.color !== false;
    const localTime =
      Boolean(opts.localTime) || (!!process.env.TZ && isValidTimeZone(process.env.TZ));

    let followRetryAttempt = 0;
    while (true) {
      let payload: LogsTailPayload;
      // Show progress spinner only on first fetch, not during follow polling
      const showProgress = first && !opts.follow;
      try {
        payload = await fetchLogs(opts, cursor, showProgress);
      } catch (err) {
        if (opts.follow && followRetryAttempt < MAX_FOLLOW_RETRIES && isTransientFollowError(err)) {
          followRetryAttempt += 1;
          const backoffMs = computeBackoff(FOLLOW_BACKOFF_POLICY, followRetryAttempt);
          const message = `[logs] gateway disconnected, reconnecting in ${Math.round(backoffMs / 1_000)}s...`;
          if (jsonMode) {
            if (!emitJsonLine({ type: "notice", message }, true)) {
              return;
            }
          } else if (!errorLine(colorize(rich, theme.warn, message))) {
            return;
          }
          await delay(backoffMs);
          continue;
        }
        await emitGatewayError(
          err,
          opts,
          jsonMode ? "json" : "text",
          rich,
          emitJsonLine,
          errorLine,
        );
        process.exit(1);
        return;
      }
      if (followRetryAttempt > 0) {
        const message = "[logs] gateway reconnected";
        if (jsonMode) {
          if (!emitJsonLine({ type: "notice", message }, true)) {
            return;
          }
        } else if (!errorLine(colorize(rich, theme.muted, message))) {
          return;
        }
      }
      followRetryAttempt = 0;
      const lines = Array.isArray(payload.lines) ? payload.lines : [];
      if (jsonMode) {
        if (first) {
          if (
            !emitJsonLine({
              type: "meta",
              file: payload.file,
              source: payload.source,
              sourceKind: payload.sourceKind,
              service: payload.service,
              cursor: payload.cursor,
              size: payload.size,
            })
          ) {
            return;
          }
        }
        for (const line of lines) {
          const parsed = parseLogLine(line);
          if (parsed) {
            if (!emitJsonLine({ type: "log", ...parsed })) {
              return;
            }
          } else {
            if (!emitJsonLine({ type: "raw", raw: line })) {
              return;
            }
          }
        }
        if (payload.truncated) {
          if (
            !emitJsonLine({
              type: "notice",
              message: "Log tail truncated (increase --max-bytes).",
            })
          ) {
            return;
          }
        }
        if (payload.reset) {
          if (
            !emitJsonLine({
              type: "notice",
              message: "Log cursor reset (file rotated).",
            })
          ) {
            return;
          }
        }
      } else {
        if (first && payload.localFallback === true) {
          const notice =
            payload.sourceKind === "journal" ? JOURNAL_FALLBACK_NOTICE : LOCAL_FALLBACK_NOTICE;
          if (!errorLine(colorize(rich, theme.warn, notice))) {
            return;
          }
        }
        if (first) {
          if (payload.sourceKind === "journal" && payload.source) {
            const prefix = pretty ? colorize(rich, theme.muted, "Log source:") : "Log source:";
            if (!logLine(`${prefix} ${payload.source}`)) {
              return;
            }
            if (
              payload.service?.pid !== undefined &&
              !logLine(`Service PID: ${payload.service.pid}`)
            ) {
              return;
            }
            if (
              payload.service?.execStart &&
              !logLine(`Service ExecStart: ${payload.service.execStart}`)
            ) {
              return;
            }
          } else if (payload.file) {
            const prefix = pretty ? colorize(rich, theme.muted, "Log file:") : "Log file:";
            if (!logLine(`${prefix} ${payload.file}`)) {
              return;
            }
          }
        }
        for (const line of lines) {
          if (
            !logLine(
              formatLogLine(line, {
                pretty,
                rich,
                localTime,
              }),
            )
          ) {
            return;
          }
        }
        if (payload.truncated) {
          if (!errorLine("Log tail truncated (increase --max-bytes).")) {
            return;
          }
        }
        if (payload.reset) {
          if (!errorLine("Log cursor reset (file rotated).")) {
            return;
          }
        }
      }
      cursor =
        typeof payload.cursor === "number" && Number.isFinite(payload.cursor)
          ? payload.cursor
          : cursor;
      first = false;

      if (!opts.follow) {
        return;
      }
      await delay(interval);
    }
  });
}
