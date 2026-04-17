import process from "node:process";
import { type LogTransportRecord, registerLogTransport } from "../logging/logger.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

// Forwarding-only error-tracking facade. The Sentry SDK ships with its own
// process-level handlers; we disable those during init so this module is the
// single seam through which openclaw's classified rejections and logger
// records reach the upstream service. The DSN gate keeps every dev/test path
// a no-op until OPENCLAW_ERROR_TRACKING_DSN is configured.

const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;
const ERROR_TRACKING_DSN_ENV = "OPENCLAW_ERROR_TRACKING_DSN";
const ERROR_TRACKING_ENV_ENV = "OPENCLAW_ERROR_TRACKING_ENVIRONMENT";
const ERROR_TRACKING_RELEASE_ENV = "OPENCLAW_ERROR_TRACKING_RELEASE";

type SentryLevel = "fatal" | "error";
type SentryCaptureContext = { level?: SentryLevel; extra?: Record<string, unknown> };
type SentryIntegration = { name: string };
type SentrySdk = {
  init: (options: Record<string, unknown>) => void;
  captureException: (err: unknown, context?: SentryCaptureContext) => void;
  captureMessage: (message: string, level?: SentryLevel) => void;
  flush: (timeoutMs?: number) => Promise<boolean>;
};

type State = {
  initialized: boolean;
  enabled: boolean;
  sentry: SentrySdk | null;
  unregisterTransport: (() => void) | null;
};

const state: State = {
  initialized: false,
  enabled: false,
  sentry: null,
  unregisterTransport: null,
};

export type InitErrorTrackingOptions = {
  dsn?: string;
  environment?: string;
  release?: string;
  // Test seam — bypasses dynamic import of @sentry/node.
  sdk?: SentrySdk;
};

export async function initErrorTracking(opts: InitErrorTrackingOptions = {}): Promise<boolean> {
  if (state.initialized) {
    return state.enabled;
  }
  state.initialized = true;

  const dsn =
    normalizeOptionalString(opts.dsn) ??
    normalizeOptionalString(process.env[ERROR_TRACKING_DSN_ENV]);
  if (!dsn) {
    return false;
  }

  let sdk: SentrySdk;
  try {
    sdk = opts.sdk ?? ((await import("@sentry/node")) as unknown as SentrySdk);
  } catch (err) {
    process.stderr.write(
      `[openclaw] error tracking disabled: failed to load @sentry/node: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return false;
  }

  const environment =
    normalizeOptionalString(opts.environment) ??
    normalizeOptionalString(process.env[ERROR_TRACKING_ENV_ENV]) ??
    normalizeOptionalString(process.env.NODE_ENV) ??
    "production";
  const release =
    normalizeOptionalString(opts.release) ??
    normalizeOptionalString(process.env[ERROR_TRACKING_RELEASE_ENV]);

  try {
    sdk.init({
      dsn,
      environment,
      ...(release ? { release } : {}),
      // openclaw owns its own unhandled-rejection/uncaught-exception flow
      // (src/infra/unhandled-rejections.ts + src/index.ts). Strip Sentry's
      // process handlers so we don't double-capture or override exit codes.
      integrations: (defaults: SentryIntegration[]) =>
        defaults.filter(
          (i) => i.name !== "OnUncaughtException" && i.name !== "OnUnhandledRejection",
        ),
    });
  } catch (err) {
    process.stderr.write(
      `[openclaw] error tracking disabled: Sentry.init failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return false;
  }

  state.sentry = sdk;
  state.enabled = true;
  state.unregisterTransport = registerLogTransport(forwardLogRecord);
  return true;
}

function forwardLogRecord(record: LogTransportRecord): void {
  const sdk = state.sentry;
  if (!state.enabled || !sdk) {
    return;
  }
  const meta = record._meta as { logLevelName?: string } | undefined;
  const levelRaw = meta?.logLevelName?.toLowerCase();
  if (levelRaw !== "error" && levelRaw !== "fatal") {
    return;
  }
  const level: SentryLevel = levelRaw === "fatal" ? "fatal" : "error";
  const err = extractErrorFromRecord(record);
  if (err) {
    try {
      sdk.captureException(err, { level });
    } catch {
      // never block on tracking failures
    }
    return;
  }
  const message = summarizeRecord(record);
  if (!message) {
    return;
  }
  try {
    sdk.captureMessage(message, level);
  } catch {
    // never block on tracking failures
  }
}

function extractErrorFromRecord(record: LogTransportRecord): Error | null {
  for (const key of Object.keys(record)) {
    if (key === "_meta" || key === "date") {
      continue;
    }
    const value = record[key];
    if (value instanceof Error) {
      return value;
    }
    // tslog wraps thrown Errors as { nativeError, name, message, stack }
    // before forwarding to transports — unwrap so Sentry sees the real object.
    if (value && typeof value === "object" && "nativeError" in value) {
      const nested = (value as { nativeError?: unknown }).nativeError;
      if (nested instanceof Error) {
        return nested;
      }
    }
  }
  return null;
}

function summarizeRecord(record: LogTransportRecord): string {
  const parts: string[] = [];
  for (const key of Object.keys(record)) {
    if (key === "_meta" || key === "date") {
      continue;
    }
    const value = record[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string") {
      parts.push(value);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      parts.push(String(value));
      continue;
    }
    try {
      parts.push(JSON.stringify(value));
    } catch {
      // skip values that cannot be serialized (e.g. circular refs)
    }
  }
  return parts.join(" ");
}

export function captureException(reason: unknown, context?: Record<string, unknown>): void {
  const sdk = state.sentry;
  if (!state.enabled || !sdk) {
    return;
  }
  try {
    const err = reason instanceof Error ? reason : new Error(stringifyReason(reason));
    sdk.captureException(err, context ? { extra: context } : undefined);
  } catch {
    // never block on tracking failures
  }
}

export async function flushErrorTracking(
  timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<boolean> {
  const sdk = state.sentry;
  if (!state.enabled || !sdk) {
    return true;
  }
  try {
    return await sdk.flush(timeoutMs);
  } catch {
    return false;
  }
}

export function isErrorTrackingEnabled(): boolean {
  return state.enabled;
}

function stringifyReason(reason: unknown): string {
  if (typeof reason === "string") {
    return reason;
  }
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

export const __test__ = {
  reset(): void {
    if (state.unregisterTransport) {
      state.unregisterTransport();
    }
    state.initialized = false;
    state.enabled = false;
    state.sentry = null;
    state.unregisterTransport = null;
  },
};
