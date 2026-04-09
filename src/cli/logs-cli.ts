import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import { formatErrorMessage } from "../infra/errors.js";
import { parseLogLine } from "../logging/parse-log-line.js";
import { formatTimestamp, isValidTimeZone } from "../logging/timestamps.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { formatDocsLink } from "../terminal/links.js";
import { clearActiveProgressLine } from "../terminal/progress-line.js";
import { createSafeStreamWriter } from "../terminal/stream-writer.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { formatCliCommand } from "./command-format.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

type LogsCliRuntimeModule = typeof import("./logs-cli.runtime.js");
type LogsGatewayClient = InstanceType<LogsCliRuntimeModule["GatewayClient"]>;

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

type LogsAppendedPayload = LogsTailPayload;

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

const FOLLOW_CONNECT_RETRY_INTERVAL_MS = 2_000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchLogs(
  opts: LogsCliOptions,
  file: string | undefined,
  cursor: number | undefined,
  showProgress: boolean,
): Promise<LogsTailPayload> {
  const limit = parsePositiveInt(opts.limit, 200);
  const maxBytes = parsePositiveInt(opts.maxBytes, 250_000);
  const payload = await callGatewayFromCli(
    "logs.tail",
    opts,
    { file, cursor, limit, maxBytes },
    { progress: showProgress },
  );
  if (!payload || typeof payload !== "object") {
    throw new Error("Unexpected logs.tail response");
  }
  return payload as LogsTailPayload;
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
    reset: () => {
      failure = null;
    },
  };
}

async function fetchLogsWithClient(
  client: LogsGatewayClient,
  opts: LogsCliOptions,
  file: string | undefined,
  cursor: number | undefined,
  includeFile: boolean,
): Promise<LogsTailPayload> {
  const limit = parsePositiveInt(opts.limit, 200);
  const maxBytes = parsePositiveInt(opts.maxBytes, 250_000);
  const payload = await client.request(
    "logs.tail",
    includeFile ? { file, cursor, limit, maxBytes } : { cursor, limit, maxBytes },
  );
  if (!payload || typeof payload !== "object") {
    throw new Error("Unexpected logs.tail response");
  }
  return payload as LogsTailPayload;
}

async function createFollowLogsClient(opts: LogsCliOptions): Promise<{
  client: LogsGatewayClient;
  methods: Set<string>;
  waitUntilReady: (opts?: { timeoutMs?: number; keepAlive?: boolean }) => Promise<void>;
  subscribeToStream: (
    file: string | undefined,
    cursor: number | undefined,
  ) => Promise<LogsTailPayload>;
  nextStreamPayload: () => Promise<LogsTailPayload>;
}> {
  const runtime = await loadLogsCliRuntime();
  const timeoutMs = parsePositiveInt(opts.timeout, 30_000);
  const { clientOptions, connectionDetails } = await runtime.resolveGatewayClientConnection({
    url: opts.url,
    token: opts.token,
    method: "logs.tail",
    timeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });

  let connected = false;
  let ready = createDeferred<void>();
  const methods = new Set<string>();
  const streamQueue = createAsyncQueue<LogsTailPayload>();

  const resetReady = () => {
    void ready.promise.catch(() => {});
    ready = createDeferred<void>();
  };

  const client = new runtime.GatewayClient({
    ...clientOptions,
    onHelloOk: (hello) => {
      connected = true;
      methods.clear();
      for (const method of Array.isArray(hello.features?.methods) ? hello.features.methods : []) {
        methods.add(method);
      }
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
        file: payload?.file,
        cursor: payload?.cursor,
        size: payload?.size,
        lines: Array.isArray(payload?.lines) ? payload.lines : [],
        truncated: payload?.truncated,
        reset: payload?.reset,
      });
    },
    onClose: (code, reason) => {
      const wasConnected = connected;
      connected = false;
      const closeError = new Error(
        reason ? `gateway closed (${code}): ${reason}` : `gateway closed (${code})`,
      ) as Error & { followRetryable?: boolean };
      closeError.followRetryable = code !== 1008;
      ready.reject(closeError);
      if (wasConnected) {
        resetReady();
        streamQueue.fail(new Error("gateway log stream disconnected"));
        return;
      }
      streamQueue.fail(closeError);
    },
  });

  const waitUntilReady = async (opts?: { timeoutMs?: number; keepAlive?: boolean }) => {
    if (connected) {
      return;
    }
    const effectiveTimeoutMs =
      typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
        ? Math.max(1, Math.floor(opts.timeoutMs))
        : timeoutMs;
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        ready.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `gateway timeout after ${effectiveTimeoutMs}ms\n${connectionDetails.message}`,
              ),
            );
          }, effectiveTimeoutMs);
          if (!opts?.keepAlive) {
            timer.unref?.();
          }
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  client.start();
  try {
    await waitUntilReady();
  } catch (err) {
    client.stop();
    throw err;
  }

  return {
    client,
    methods,
    waitUntilReady,
    subscribeToStream: async (file, cursor) => {
      streamQueue.reset();
      const limit = parsePositiveInt(opts.limit, 200);
      const maxBytes = parsePositiveInt(opts.maxBytes, 250_000);
      const payload = await client.request("logs.subscribe", { file, cursor, limit, maxBytes });
      if (!payload || typeof payload !== "object") {
        throw new Error("Unexpected logs.subscribe response");
      }
      return payload as LogsTailPayload;
    },
    nextStreamPayload: async () => await streamQueue.next(),
  };
}

function supportsStreamingFollow(methods: ReadonlySet<string>): boolean {
  return methods.has("logs.subscribe") && methods.has("logs.unsubscribe");
}

async function waitForFollowClientReconnect(params: {
  followClient: {
    waitUntilReady: (opts?: { timeoutMs?: number; keepAlive?: boolean }) => Promise<void>;
  };
  opts: LogsCliOptions;
  rich: boolean;
  jsonMode: boolean;
  retryMs: number;
  emitJsonLine: (payload: Record<string, unknown>, toStdErr?: boolean) => boolean;
  errorLine: (text: string) => boolean;
}): Promise<void> {
  for (;;) {
    try {
      await params.followClient.waitUntilReady({
        timeoutMs: params.retryMs,
        keepAlive: true,
      });
      return;
    } catch (err) {
      if (!isRetryableFollowStartupError(err)) {
        throw err;
      }
      await emitFollowStartupRetryNotice({
        err,
        opts: params.opts,
        firstFailure: false,
        rich: params.rich,
        jsonMode: params.jsonMode,
        retryMs: params.retryMs,
        emitJsonLine: params.emitJsonLine,
        errorLine: params.errorLine,
      });
      await delay(params.retryMs);
    }
  }
}

function isRetryableFollowStartupError(err: unknown): boolean {
  if (err && typeof err === "object" && "followRetryable" in err) {
    const retryable = (err as { followRetryable?: unknown }).followRetryable;
    if (typeof retryable === "boolean") {
      return retryable;
    }
  }
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes("connect failed") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("ehostunreach") ||
    message.includes("enetunreach") ||
    message.includes("enotfound") ||
    message.includes("eai_again") ||
    message.includes("etimedout") ||
    message.includes("socket hang up") ||
    message.includes("gateway timeout after") ||
    message.includes("abnormal closure") ||
    message.includes("gateway closed") ||
    message.includes("gateway log stream disconnected") ||
    message.includes("gateway not connected") ||
    message.includes("gateway client stopped")
  );
}

function formatRetryDelayLabel(retryMs: number): string {
  return retryMs % 1000 === 0 ? `${retryMs / 1000}s` : `${retryMs}ms`;
}

function summarizeRetryErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split(/\r?\n/u, 1)[0]?.trim().replace(/\s+/gu, " ");
}

async function emitFollowStartupRetryNotice(params: {
  err: unknown;
  opts: LogsCliOptions;
  firstFailure: boolean;
  rich: boolean;
  jsonMode: boolean;
  retryMs: number;
  emitJsonLine: (payload: Record<string, unknown>, toStdErr?: boolean) => boolean;
  errorLine: (text: string) => boolean;
}): Promise<void> {
  const { err, opts, firstFailure, rich, jsonMode, retryMs, emitJsonLine, errorLine } = params;
  const runtime = await loadLogsCliRuntime();
  const details = runtime.buildGatewayConnectionDetails({ url: opts.url });
  const errorText = err instanceof Error ? err.message : String(err);
  const retryErrorText = summarizeRetryErrorText(err);
  const delayLabel = formatRetryDelayLabel(retryMs);

  if (jsonMode) {
    emitJsonLine(
      firstFailure
        ? {
            type: "notice",
            message: "Gateway not reachable yet; waiting for it before following logs.",
            error: errorText,
            details,
            retryMs,
            retrying: true,
          }
        : {
            type: "notice",
            message: "Still waiting for gateway before following logs.",
            error: retryErrorText,
            retryMs,
            retrying: true,
          },
      true,
    );
    return;
  }

  if (firstFailure) {
    errorLine(
      colorize(
        rich,
        theme.warn,
        "Gateway not reachable yet; waiting for it before following logs.",
      ),
    );
    errorLine(details.message);
    errorLine(colorize(rich, theme.muted, `Reason: ${errorText}`));
    errorLine(colorize(rich, theme.muted, `Retrying every ${delayLabel}. Press Ctrl+C to stop.`));
    return;
  }

  errorLine(
    colorize(
      rich,
      theme.muted,
      `Still waiting for gateway (${retryErrorText}). Retrying in ${delayLabel}...`,
    ),
  );
}

async function connectFollowLogsClientWithRetry(params: {
  opts: LogsCliOptions;
  rich: boolean;
  jsonMode: boolean;
  emitJsonLine: (payload: Record<string, unknown>, toStdErr?: boolean) => boolean;
  errorLine: (text: string) => boolean;
}): Promise<{
  client: LogsGatewayClient;
  methods: Set<string>;
  waitUntilReady: (opts?: { timeoutMs?: number; keepAlive?: boolean }) => Promise<void>;
  subscribeToStream: (
    file: string | undefined,
    cursor: number | undefined,
  ) => Promise<LogsTailPayload>;
  nextStreamPayload: () => Promise<LogsTailPayload>;
}> {
  const retryMs = FOLLOW_CONNECT_RETRY_INTERVAL_MS;
  let firstFailure = true;

  for (;;) {
    try {
      return await createFollowLogsClient(params.opts);
    } catch (err) {
      if (!isRetryableFollowStartupError(err)) {
        throw err;
      }
      await emitFollowStartupRetryNotice({
        err,
        opts: params.opts,
        firstFailure,
        rich: params.rich,
        jsonMode: params.jsonMode,
        retryMs,
        emitJsonLine: params.emitJsonLine,
        errorLine: params.errorLine,
      });
      firstFailure = false;
      await delay(retryMs);
    }
  }
}

export const __testing = {
  isRetryableFollowStartupError,
  supportsStreamingFollow,
  waitForFollowClientReconnect,
};

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
    if (!localTime) {
      const match =
        /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
      if (match) {
        const [, , time, offsetRaw] = match;
        return `${time}${offsetRaw === "Z" ? "+00:00" : offsetRaw}`;
      }
      return value;
    }
    return formatTimestamp(parsed, { style: "short" });
  }
  return localTime ? formatTimestamp(parsed, { style: "long" }) : value;
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
    return sanitizeForLog(raw);
  }
  const label = sanitizeForLog(parsed.subsystem ?? parsed.module ?? "");
  const time = sanitizeForLog(
    formatLogTimestamp(parsed.time, opts.pretty ? "pretty" : "plain", opts.localTime),
  );
  const level = sanitizeForLog(parsed.level ?? "");
  const levelLabel = level.padEnd(5).trim();
  const message = sanitizeForLog(parsed.message || parsed.raw);

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
): Promise<void> {
  const runtime = await loadLogsCliRuntime();
  const details = runtime.buildGatewayConnectionDetails({ url: opts.url });
  const message = "Gateway not reachable. Is it running and accessible?";
  const hint = `Hint: run \`${formatCliCommand("openclaw doctor")}\`.`;
  const errorText = formatErrorMessage(err);

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
  if (errorText.trim()) {
    if (!errorLine(colorize(rich, theme.muted, `Reason: ${summarizeRetryErrorText(err)}`))) {
      return;
    }
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
    let currentFile: string | undefined;
    let cursor: number | undefined;
    let first = true;
    const jsonMode = Boolean(opts.json);
    const pretty = !jsonMode && Boolean(process.stdout.isTTY) && !opts.plain;
    const rich = isRich() && opts.color !== false;
    const localTime =
      Boolean(opts.localTime) || (!!process.env.TZ && isValidTimeZone(process.env.TZ));
    let followClient: Awaited<ReturnType<typeof connectFollowLogsClientWithRetry>> | null = null;

    try {
      if (opts.follow) {
        followClient = await connectFollowLogsClientWithRetry({
          opts,
          rich,
          jsonMode,
          emitJsonLine,
          errorLine,
        });
      }
      while (true) {
        if (followClient && supportsStreamingFollow(followClient.methods)) {
          try {
            const payload = await followClient.subscribeToStream(currentFile, cursor);
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
            currentFile =
              typeof payload.file === "string" && payload.file.trim().length > 0
                ? payload.file
                : currentFile;
            cursor =
              typeof payload.cursor === "number" && Number.isFinite(payload.cursor)
                ? payload.cursor
                : cursor;
            first = false;

            for (;;) {
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
              currentFile =
                typeof streamedPayload.file === "string" && streamedPayload.file.trim().length > 0
                  ? streamedPayload.file
                  : currentFile;
              cursor =
                typeof streamedPayload.cursor === "number" &&
                Number.isFinite(streamedPayload.cursor)
                  ? streamedPayload.cursor
                  : cursor;
              first = false;
            }
          } catch (err) {
            if (opts.follow && isRetryableFollowStartupError(err)) {
              await emitFollowStartupRetryNotice({
                err,
                opts,
                firstFailure: false,
                rich,
                jsonMode,
                retryMs: FOLLOW_CONNECT_RETRY_INTERVAL_MS,
                emitJsonLine,
                errorLine,
              });
              await delay(FOLLOW_CONNECT_RETRY_INTERVAL_MS);
              await waitForFollowClientReconnect({
                followClient,
                opts,
                rich,
                jsonMode,
                retryMs: FOLLOW_CONNECT_RETRY_INTERVAL_MS,
                emitJsonLine,
                errorLine,
              });
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
        }

        let payload: LogsTailPayload;
        // Show progress spinner only on first fetch, not during follow polling
        const showProgress = first && !opts.follow;
        try {
          if (followClient) {
            await followClient.waitUntilReady();
            payload = await fetchLogsWithClient(
              followClient.client,
              opts,
              currentFile,
              cursor,
              supportsStreamingFollow(followClient.methods),
            );
          } else {
            payload = await fetchLogs(opts, currentFile, cursor, showProgress);
          }
        } catch (err) {
          if (opts.follow && isRetryableFollowStartupError(err)) {
            await emitFollowStartupRetryNotice({
              err,
              opts,
              firstFailure: false,
              rich,
              jsonMode,
              retryMs: FOLLOW_CONNECT_RETRY_INTERVAL_MS,
              emitJsonLine,
              errorLine,
            });
            await delay(FOLLOW_CONNECT_RETRY_INTERVAL_MS);
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
        currentFile =
          typeof payload.file === "string" && payload.file.trim().length > 0
            ? payload.file
            : currentFile;
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
    } catch (err) {
      await emitGatewayError(err, opts, jsonMode ? "json" : "text", rich, emitJsonLine, errorLine);
      process.exit(1);
      return;
    } finally {
      if (followClient) {
        const activeFollowClient = followClient;
        if (supportsStreamingFollow(activeFollowClient.methods)) {
          await Promise.resolve()
            .then(async () => await activeFollowClient.client.request("logs.unsubscribe"))
            .catch(() => {});
        }
        await activeFollowClient.client.stopAndWait().catch(() => {
          activeFollowClient.client.stop();
        });
      }
    }
  });
}
