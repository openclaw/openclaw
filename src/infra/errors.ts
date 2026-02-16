import { redactSensitiveText } from "../logging/redact.js";

export function extractErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    return code;
  }
  if (typeof code === "number") {
    return String(code);
  }
  return undefined;
}

/**
 * Type guard for NodeJS.ErrnoException (any error with a `code` property).
 */
export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === "object" && "code" in err);
}

/**
 * Check if an error has a specific errno code.
 */
export function hasErrnoCode(err: unknown, code: string): boolean {
  return isErrno(err) && err.code === code;
}

export function formatErrorMessage(err: unknown): string {
  let formatted: string;
  if (err instanceof Error) {
    formatted = err.message || err.name || "Error";
  } else if (typeof err === "string") {
    formatted = err;
  } else if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    formatted = String(err);
  } else {
    try {
      formatted = JSON.stringify(err);
    } catch {
      formatted = Object.prototype.toString.call(err);
    }
  }
  // Security: best-effort token redaction before returning/logging.
  return redactSensitiveText(formatted);
}

/**
 * Detect transient Discord gateway errors thrown by `@buape/carbon` inside
 * `setTimeout`/`setInterval` callbacks (e.g. heartbeat reconnect on zombie
 * connections).  These surface as uncaught exceptions but are non-fatal –
 * the gateway's own reconnection logic will recover.
 */
export function isTransientGatewayError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message;
  return (
    msg.includes("Attempted to reconnect zombie connection") ||
    msg.includes("Attempted to reconnect gateway after disconnecting first")
  );
}

export function formatUncaughtError(err: unknown): string {
  if (extractErrorCode(err) === "INVALID_CONFIG") {
    return formatErrorMessage(err);
  }
  if (err instanceof Error) {
    const stack = err.stack ?? err.message ?? err.name;
    return redactSensitiveText(stack);
  }
  return formatErrorMessage(err);
}
