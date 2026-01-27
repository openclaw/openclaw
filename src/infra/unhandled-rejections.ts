import process from "node:process";

import { formatErrorMessage, formatUncaughtError } from "./errors.js";

type UnhandledRejectionHandler = (reason: unknown) => boolean;

const handlers = new Set<UnhandledRejectionHandler>();

export function registerUnhandledRejectionHandler(handler: UnhandledRejectionHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Check if an error is a recoverable/transient error that shouldn't crash the process.
 * These include network errors and abort signals during shutdown.
 */
function isRecoverableError(reason: unknown): boolean {
  if (!reason) return false;

  // Check error name for AbortError
  if (reason instanceof Error && reason.name === "AbortError") {
    return true;
  }

  const message = reason instanceof Error ? reason.message : formatErrorMessage(reason);
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes("fetch failed") ||
    lowerMessage.includes("network request") ||
    lowerMessage.includes("econnrefused") ||
    lowerMessage.includes("econnreset") ||
    lowerMessage.includes("etimedout") ||
    lowerMessage.includes("socket hang up") ||
    lowerMessage.includes("enotfound") ||
    lowerMessage.includes("network error") ||
    lowerMessage.includes("getaddrinfo") ||
    lowerMessage.includes("client network socket disconnected") ||
    lowerMessage.includes("this operation was aborted") ||
    lowerMessage.includes("aborted")
  );
}

export function isUnhandledRejectionHandled(reason: unknown): boolean {
  for (const handler of handlers) {
    try {
      if (handler(reason)) return true;
    } catch (err) {
      console.error(
        "[clawdbot] Unhandled rejection handler failed:",
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
    }
  }
  return false;
}

export function installUnhandledRejectionHandler(): void {
  process.on("unhandledRejection", (reason, _promise) => {
    if (isUnhandledRejectionHandled(reason)) return;

    // Don't crash on recoverable/transient errors - log them and continue
    if (isRecoverableError(reason)) {
      console.error("[clawdbot] Recoverable error (not crashing):", formatUncaughtError(reason));
      return;
    }

    console.error("[clawdbot] Unhandled promise rejection:", formatUncaughtError(reason));
    process.exit(1);
  });
}
