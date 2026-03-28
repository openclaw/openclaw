import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import { resolveGatewayClientConnection } from "../gateway/call.js";
import { GatewayClient } from "../gateway/client.js";
import { parseLogLine } from "../logging/parse-log-line.js";
import { formatTimestamp, isValidTimeZone } from "../logging/timestamps.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { formatDocsLink } from "../terminal/links.js";
import { clearActiveProgressLine } from "../terminal/progress-line.js";
import { createSafeStreamWriter } from "../terminal/stream-writer.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { formatCliCommand } from "./command-format.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

type LogsCliRuntimeModule = typeof import("./logs-cli.runtime.js");

let logsCliRuntimePromise: Promise<LogsCliRuntimeModule> | undefined;

async function loadLogsCliRuntime(): Promise<LogsCliRuntimeModule> {
  logsCliRuntimePromise ??= import("./logs-cli.runtime.js");
  return logsCliRuntimePromise;
}

type LogsTailPayload = {
  file?: string;
  cursor?: number;
  size?: number;
  lines?: string[];
  truncated?: boolean;
  reset?: boolean;
  localFallback?: boolean;
};

type LogsAppendedPayload = {
  lines?: string[];
};

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

const LOCAL_FALLBACK_NOTICE = "Gateway pairing required; reading local log file instead.";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchLogs(
  opts: LogsCliOptions,
  cursor: number | undefined,
  showProgress: boolean,
): Promise<LogsTailPayload> {
  const limit = parsePositiveInt(opts.limit, 200);
  const maxBytes = parsePositiveInt(opts.maxBytes, 250_000);
  try {
    const payload = await callGatewayFromCli(
      "logs.tail",
      opts,
      { cursor, limit, maxBytes },
      { progress: showProgress },
    );
    if (!payload || typeof payload !== "object") {
      throw new Error("Unexpected logs.tail response");
    }
    return payload as LogsTailPayload;
  } catch (error) {
    if (!shouldUseLocalLogsFallback(opts, error)) {
      throw error;
    }
    return {
      ...(await readConfiguredLogTail({ cursor, limit, maxBytes })),
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
  const message = normalizeLowercaseStringOrEmpty(normalizeErrorMessage(error));
  if (!message.includes("pairing required")) {
    return false;
  }
  if (typeof opts.url === "string" && opts.url.trim().length > 0) {
    return false;
  }
  const connection = buildGatewayConnectionDetails();
  if (connection.urlSource !== "local loopback") {
    return false;
  }
  try {
    return isLoopbackHost(new URL(connection.url).hostname);
  } catch {
    return false;
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createAsyncQueue<T>() {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  let failure: Error | null = null;

  return {
    push: (value: T) => {
      if (failure) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(value);
        return;
      }
      values.push(value);
    },
    fail: (err: Error) => {
      if (failure) {
        return;
      }
      failure = err;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(err);
      }
    },
    next: async () => {
      if (values.length > 0) {
        return values.shift() as T;
      }
      if (failure) {
        throw failure;
      }
      return await new Promise<T>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
}

async function fetchLogsWithClient(
  client: GatewayClient,
  opts: LogsCliOptions,
  cursor: number | undefined,
): Promise<LogsTailPayload> {
  const limit = parsePositiveInt(opts.limit, 200);
  const maxBytes = parsePositiveInt(opts.maxBytes, 250_000);
  const payload = await client.request("logs.tail", { cursor, limit, maxBytes });
  if (!payload || typeof payload !== "object") {
    throw new Error("Unexpected logs.tail response");
  }
  return payload as LogsTailPayload;
}

async function createFollowLogsClient(opts: LogsCliOptions): Promise<{
  client: GatewayClient;
  methods: Set<string>;
  waitUntilReady: () => Promise<void>;
  subscribeToStream: (cursor: number | undefined) => Promise<LogsTailPayload>;
  nextStreamPayload: () => Promise<LogsTailPayload>;
}> {
  const timeoutMs = parsePositiveInt(opts.timeout, 30_000);
  const { clientOptions, connectionDetails } = await resolveGatewayClientConnection({
    url: opts.url,
    token: opts.token,
    method: "logs.tail",
    timeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });

  let connected = false;
  let ready = createDeferred<void>();
  let methods = new Set<string>();
  const streamQueue = createAsyncQueue<LogsTailPayload>();

  const resetReady = () => {
    ready = createDeferred<void>();
  };

  const client = new GatewayClient({
    ...clientOptions,
    onHelloOk: (hello) => {
      connected = true;
      methods = new Set(Array.isArray(hello.features?.methods) ? hello.features.methods : []);
      ready.resolve();
    },
    onConnectError: (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      ready.reject(error);
      streamQueue.fail(error);
    },
    onEvent: (evt) => {
      if (evt.event !== "logs.appended") {
        return;
      }
      const payload = evt.payload as LogsAppendedPayload | undefined;
      streamQueue.push({
        lines: Array.isArray(payload?.lines) ? payload.lines : [],
      });
    },
    onClose: () => {
      connected = false;
      resetReady();
      streamQueue.fail(new Error("gateway log stream disconnected"));
    },
  });

  const waitUntilReady = async () => {
    if (connected) {
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        ready.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  client.start();
  await waitUntilReady();

  async function subscribeToStream(cursor: number | undefined): Promise<LogsTailPayload> {
    const limit = parsePositiveInt(opts.limit, 200);
    const maxBytes = parsePositiveInt(opts.maxBytes, 250_000);
    const payload = await client.request("logs.subscribe", {
      cursor,
      limit,
      maxBytes,
    });
    if (!payload || typeof payload !== "object") {
      throw new Error("Unexpected logs.subscribe response");
    }
    return payload as LogsTailPayload;
  }

  return {
    client,
    methods,
    waitUntilReady,
    subscribeToStream,
    nextStreamPayload: async () => await streamQueue.next(),
  };
}

function emitLogsPayload(params: {
  payload: LogsTailPayload;
  first: boolean;
  jsonMode: boolean;
  pretty: boolean;
  rich: boolean;
  localTime: boolean;
  emitJsonLine: (payload: Record<string, unknown>, toStdErr?: boolean) => boolean;
  logLine: (text: string) => boolean;
  errorLine: (text: string) => boolean;
}): boolean {
  const { payload, first, jsonMode, pretty, rich, localTime, emitJsonLine, logLine, errorLine } =
    params;
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (jsonMode) {
    if (first) {
      if (
        !emitJsonLine({
          type: "meta",
          file: payload.file,
          cursor: payload.cursor,
          size: payload.size,
        })
      ) {
        return false;
      }
    }
    for (const line of lines) {
      const parsed = parseLogLine(line);
      if (parsed) {
        if (!emitJsonLine({ type: "log", ...parsed })) {
          return false;
        }
      } else {
        if (!emitJsonLine({ type: "raw", raw: line })) {
          return false;
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
        return false;
      }
    }
    if (payload.reset) {
      if (
        !emitJsonLine({
          type: "notice",
          message: "Log cursor reset (file rotated).",
        })
      ) {
        return false;
      }
    }
    return true;
  }

  if (first && payload.file) {
    const prefix = pretty ? colorize(rich, theme.muted, "Log file:") : "Log file:";
    if (!logLine(`${prefix} ${payload.file}`)) {
      return false;
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
      return false;
    }
  }
  if (payload.truncated) {
    if (!errorLine("Log tail truncated (increase --max-bytes).")) {
      return false;
    }
  }
  if (payload.reset) {
    if (!errorLine("Log cursor reset (file rotated).")) {
      return false;
    }
  }
  return true;
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
    let cursor: number | undefined;
    let first = true;
    const jsonMode = Boolean(opts.json);
    const pretty = !jsonMode && Boolean(process.stdout.isTTY) && !opts.plain;
    const rich = isRich() && opts.color !== false;
    const localTime =
      Boolean(opts.localTime) || (!!process.env.TZ && isValidTimeZone(process.env.TZ));
    const followClient = opts.follow ? await createFollowLogsClient(opts) : null;
    const supportsStreamingFollow =
      followClient &&
      followClient.methods.has("logs.subscribe") &&
      followClient.methods.has("logs.unsubscribe");

    try {
      if (supportsStreamingFollow) {
        try {
          const payload = await followClient.subscribeToStream(cursor);
          if (
            !emitLogsPayload({
              payload,
              first,
              jsonMode,
              pretty,
              rich,
              localTime,
              emitJsonLine,
              logLine,
              errorLine,
            })
          ) {
            return;
          }
          cursor =
            typeof payload.cursor === "number" && Number.isFinite(payload.cursor)
              ? payload.cursor
              : cursor;
          first = false;
          while (true) {
            const streamedPayload = await followClient.nextStreamPayload();
            if (
              !emitLogsPayload({
                payload: streamedPayload,
                first,
                jsonMode,
                pretty,
                rich,
                localTime,
                emitJsonLine,
                logLine,
                errorLine,
              })
            ) {
              return;
            }
            first = false;
          }
        } catch (err) {
          emitGatewayError(err, opts, jsonMode ? "json" : "text", rich, emitJsonLine, errorLine);
          process.exit(1);
          return;
        }
      }

      while (true) {
        let payload: LogsTailPayload;
        // Show progress spinner only on first fetch, not during follow polling
        const showProgress = first && !opts.follow;
        try {
          if (followClient) {
            await followClient.waitUntilReady();
            payload = await fetchLogsWithClient(followClient.client, opts, cursor);
          } else {
            payload = await fetchLogs(opts, cursor, showProgress);
          }
        } catch (err) {
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
        if (
          !emitLogsPayload({
            payload,
            first,
            jsonMode,
            pretty,
            rich,
            localTime,
            emitJsonLine,
            logLine,
            errorLine,
          })
        ) {
          return;
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
    } finally {
      if (followClient) {
        if (supportsStreamingFollow) {
          await followClient.client.request("logs.unsubscribe").catch(() => {});
        }
        await followClient.client.stopAndWait().catch(() => {
          followClient.client.stop();
        });
      }
    }
  });
}
