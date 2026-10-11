import process from "node:process";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { exitAfterSignalExitBarriers } from "../cli/signal-exit-barrier.js";
import { restoreRuntimeTerminalState } from "../runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { registerListener } from "../shared/listeners.js";
import { isAbortError } from "./abort-signal.js";
import { collectNestedErrorCandidates, extractErrorCodeOrErrno } from "./error-graph-internal.js";
import { extractErrorCode, formatUncaughtError, readErrorCause, readErrorName } from "./errors.js";
import { runFatalErrorHooks } from "./fatal-error-hooks.js";
import { isTransientNetworkError } from "./retryable-network-errors.js";

export { isTransientNetworkError } from "./retryable-network-errors.js";

type ErrorHandler = (error: unknown) => boolean;

// Plugins resolve `openclaw/plugin-sdk/runtime` through their own staged
// `node_modules`, which loads a separate copy of this module. To keep registry
// state shared across instances, anchor the handlers Set on globalThis.
const HANDLERS_GLOBAL_KEY = Symbol.for("openclaw.unhandledRejection.handlers");
const EXCEPTION_HANDLERS_GLOBAL_KEY = Symbol.for("openclaw.uncaughtException.handlers");
function createErrorHandlerRegistry(globalKey: symbol, failureMessage: string) {
  const handlers = resolveGlobalSingleton(globalKey, () => new Set<ErrorHandler>());
  return {
    register(handler: ErrorHandler): () => void {
      return registerListener(handlers, handler);
    },
    isHandled(error: unknown): boolean {
      for (const handler of handlers) {
        try {
          if (handler(error)) {
            return true;
          }
        } catch (err) {
          console.error(failureMessage, err instanceof Error ? (err.stack ?? err.message) : err);
        }
      }
      return false;
    },
  };
}

const rejectionRegistry = createErrorHandlerRegistry(
  HANDLERS_GLOBAL_KEY,
  "[openclaw] Unhandled rejection handler failed:",
);
const exceptionRegistry = createErrorHandlerRegistry(
  EXCEPTION_HANDLERS_GLOBAL_KEY,
  "[openclaw] Uncaught exception handler failed:",
);

const FATAL_ERROR_CODES = new Set([
  "ERR_OUT_OF_MEMORY",
  "ERR_SCRIPT_EXECUTION_TIMEOUT",
  "ERR_WORKER_OUT_OF_MEMORY",
  "ERR_WORKER_UNCAUGHT_EXCEPTION",
  "ERR_WORKER_INITIALIZATION_FAILED",
]);

const INVALID_CONFIG_ERROR_CODE = "INVALID_CONFIG";
const CONFIG_ERROR_CODES = new Set([
  INVALID_CONFIG_ERROR_CODE,
  "MISSING_API_KEY",
  "MISSING_CREDENTIALS",
]);
const EXIT_CONFIG_ERROR = 78;

const TRANSIENT_SQLITE_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_CANTOPEN",
  "SQLITE_IOERR",
  "SQLITE_LOCKED",
]);

const TRANSIENT_SQLITE_ERRCODES = new Set([5, 6, 10, 14]);

const BENIGN_UNCAUGHT_EXCEPTION_CODES = new Set(["EPIPE", "EIO"]);
const BENIGN_UNCAUGHT_EXCEPTION_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENETDOWN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_DNS_RESOLVE_FAILED",
  "UND_ERR_CONNECT",
  "ERR_HTTP2_INVALID_SESSION",
]);

const BENIGN_UNCAUGHT_EXCEPTION_NETWORK_MESSAGE_CODE_RE =
  /\b(ECONNREFUSED|ENETDOWN|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_DNS_RESOLVE_FAILED|UND_ERR_CONNECT|ERR_HTTP2_INVALID_SESSION)\b/i;
const WS_PRE_HANDSHAKE_CLOSE_MESSAGE = "websocket was closed before the connection was established";
const UNDICI_TERMINATED_TYPE_ERROR_MESSAGE = "terminated";

const TRANSIENT_SQLITE_MESSAGE_CODE_RE =
  /\b(SQLITE_BUSY|SQLITE_CANTOPEN|SQLITE_IOERR|SQLITE_LOCKED)\b/i;

const TRANSIENT_SQLITE_MESSAGE_SNIPPETS = [
  "unable to open database file",
  "database is locked",
  "database table is locked",
  "disk i/o error",
];

function hasSqliteSignal(err: unknown): err is Record<string, unknown> {
  const record = asOptionalObjectRecord(err);
  if (!record) {
    return false;
  }
  const code = extractErrorCode(err)?.trim().toUpperCase();
  return (
    code === "ERR_SQLITE_ERROR" ||
    code?.startsWith("SQLITE_") === true ||
    normalizeLowercaseStringOrEmpty(readErrorName(err)).includes("sqlite") ||
    normalizeLowercaseStringOrEmpty(record.message).includes("sqlite")
  );
}

function extractErrorCodeWithCause(err: unknown): string | undefined {
  return extractErrorCode(err) || extractErrorCode(readErrorCause(err));
}

export function isTransientSqliteError(err: unknown): boolean {
  if (!err) {
    return false;
  }

  for (const candidate of collectNestedErrorCandidates(err)) {
    const code = extractErrorCodeOrErrno(candidate);
    if (code && TRANSIENT_SQLITE_CODES.has(code)) {
      return true;
    }

    if (!hasSqliteSignal(candidate)) {
      continue;
    }

    const value = candidate.errcode;
    const sqliteErrcode = asFiniteNumber(
      typeof value === "string" && value.trim() ? Number(value) : value,
    );
    if (sqliteErrcode !== undefined && TRANSIENT_SQLITE_ERRCODES.has(sqliteErrcode)) {
      return true;
    }

    const messageParts = [candidate.message, candidate.errstr];
    for (const rawMessage of messageParts) {
      const message = normalizeLowercaseStringOrEmpty(rawMessage);
      if (TRANSIENT_SQLITE_MESSAGE_CODE_RE.test(message)) {
        return true;
      }
      if (TRANSIENT_SQLITE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
        return true;
      }
    }
  }

  return false;
}

/** Requires watcher evidence so ordinary ENOSPC storage failures remain fatal. */
function isTransientFileWatchError(err: unknown): boolean {
  if (!err) {
    return false;
  }

  const hasFileWatchSignal = (message: string) =>
    message.includes("inotify") ||
    message.includes("watcher") ||
    message.includes("watch limit") ||
    message.includes("max watches");
  const hasFileWatchExhaustionSignal = (message: string) =>
    message.includes("inotify watches") ||
    message.includes("inotify watch") ||
    message.includes("system limit for number of file watchers") ||
    message.includes("watch limit") ||
    message.includes("max watches");

  for (const candidate of collectNestedErrorCandidates(err)) {
    const record = asOptionalObjectRecord(candidate);
    if (!record) {
      continue;
    }

    const code = extractErrorCodeOrErrno(candidate);
    const message = normalizeLowercaseStringOrEmpty(record.message);

    // ENOSPC requires both the code AND a watch/inotify message indicator
    // to avoid misclassifying general disk-full errors as transient watcher errors.
    if (code === "ENOSPC") {
      if (hasFileWatchSignal(message)) {
        return true;
      }
      continue;
    }

    // Without an ENOSPC code, only classify explicit watcher resource exhaustion.
    // Generic "file watcher failed" labels can wrap permission/config/runtime failures.
    if (
      (message.includes("no space left on device") && hasFileWatchSignal(message)) ||
      hasFileWatchExhaustionSignal(message)
    ) {
      return true;
    }
  }

  return false;
}

export function isTransientUnhandledRejectionError(err: unknown): boolean {
  return (
    isTransientNetworkError(err) || isTransientSqliteError(err) || isTransientFileWatchError(err)
  );
}

export function isBenignUncaughtExceptionError(err: unknown): boolean {
  for (const candidate of collectNestedErrorCandidates(err)) {
    // Undici emits this bare TypeError when a response body aborts after request start.
    // Keep the shape exact so unrelated "terminated" errors still take the fatal path.
    if (
      candidate instanceof TypeError &&
      normalizeLowercaseStringOrEmpty(candidate.message) === UNDICI_TERMINATED_TYPE_ERROR_MESSAGE
    ) {
      return true;
    }

    const code = extractErrorCodeOrErrno(candidate);
    if (
      code &&
      (BENIGN_UNCAUGHT_EXCEPTION_NETWORK_CODES.has(code) ||
        BENIGN_UNCAUGHT_EXCEPTION_CODES.has(code))
    ) {
      return true;
    }
    const message = normalizeLowercaseStringOrEmpty(asOptionalObjectRecord(candidate)?.message);
    // `ws` emits this exact Error when close()/terminate() aborts a CONNECTING socket.
    // Keep exact matching so arbitrary WebSocket errors still take the fatal path.
    if (
      BENIGN_UNCAUGHT_EXCEPTION_NETWORK_MESSAGE_CODE_RE.test(message) ||
      message === WS_PRE_HANDSHAKE_CLOSE_MESSAGE
    ) {
      return true;
    }
  }
  return false;
}

export function registerUnhandledRejectionHandler(handler: ErrorHandler): () => void {
  return rejectionRegistry.register(handler);
}

export function registerUncaughtExceptionHandler(handler: ErrorHandler): () => void {
  return exceptionRegistry.register(handler);
}

export function isUncaughtExceptionHandled(error: unknown): boolean {
  return exceptionRegistry.isHandled(error);
}

export function installUnhandledRejectionHandler(): void {
  const exitWithTerminalRestore = (
    reason: string,
    error?: unknown,
    hookReason = reason,
    exitCode = 1,
  ) => {
    for (const message of runFatalErrorHooks({ reason: hookReason, error })) {
      console.error("[openclaw]", message);
    }
    restoreRuntimeTerminalState(reason, { resumeStdinIfPaused: false });
    exitAfterSignalExitBarriers(exitCode);
  };

  process.on("unhandledRejection", (reason, _promise) => {
    if (rejectionRegistry.isHandled(reason)) {
      return;
    }

    // Cancellation during shutdown is expected.
    if (isAbortError(reason)) {
      console.warn("[openclaw] Suppressed AbortError:", formatUncaughtError(reason));
      return;
    }

    const code = extractErrorCodeWithCause(reason);
    if (code !== undefined && FATAL_ERROR_CODES.has(code)) {
      console.error("[openclaw] FATAL unhandled rejection:", formatUncaughtError(reason));
      exitWithTerminalRestore("fatal unhandled rejection", reason, "fatal_unhandled_rejection");
      return;
    }

    if (code !== undefined && CONFIG_ERROR_CODES.has(code)) {
      console.error("[openclaw] CONFIGURATION ERROR - requires fix:", formatUncaughtError(reason));
      const exitCode = code === INVALID_CONFIG_ERROR_CODE ? EXIT_CONFIG_ERROR : 1;
      exitWithTerminalRestore("configuration error", reason, "configuration_error", exitCode);
      return;
    }

    if (isTransientUnhandledRejectionError(reason)) {
      console.warn(
        "[openclaw] Non-fatal unhandled rejection (continuing):",
        formatUncaughtError(reason),
      );
      return;
    }

    console.error("[openclaw] Unhandled promise rejection:", formatUncaughtError(reason));
    exitWithTerminalRestore("unhandled rejection", reason, "unhandled_rejection");
  });
}
