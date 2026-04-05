import type { SubsystemLogger } from "../logging/subsystem.js";

export type IoErrorCategory =
  | "not-found"
  | "permission-denied"
  | "disk-full"
  | "locked"
  | "unknown";

export interface IoErrorContext {
  operation: "read" | "write" | "delete" | "mkdir" | "stat" | "copy";
  path: string;
  error: unknown;
}

export function classifyIoError(context: IoErrorContext): IoErrorCategory {
  const { error } = context;
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : null;

  if (code === "ENOENT" || message.includes("ENOENT") || message.includes("no such file")) {
    return "not-found";
  }
  if (code === "EACCES" || code === "EPERM" || message.includes("EACCES") || message.includes("permission denied")) {
    return "permission-denied";
  }
  if (code === "ENOSPC" || code === "EIO" || message.includes("disk full") || message.includes("no space left")) {
    return "disk-full";
  }
  if (code === "EBUSY" || code === "ETXTBSY" || message.includes("locked")) {
    return "locked";
  }

  return "unknown";
}

export function getLogLevelForIoError(category: IoErrorCategory): "debug" | "warn" | "error" {
  switch (category) {
    case "not-found":
      return "debug";
    case "locked":
      return "debug";
    case "permission-denied":
      return "warn";
    case "disk-full":
      return "error";
    case "unknown":
      return "warn";
  }
}

export interface LogIoErrorOptions {
  logger: SubsystemLogger | null | undefined;
  operation: IoErrorContext["operation"];
  path: string;
  error: unknown;
  context?: Record<string, unknown>;
}

export function logIoError(options: LogIoErrorOptions): void {
  const { logger, operation, path, error, context } = options;
  if (!logger) {
    return;
  }

  const errorContext: IoErrorContext = { operation, path, error };
  const category = classifyIoError(errorContext);
  const level = getLogLevelForIoError(category);
  const message = error instanceof Error ? error.message : String(error);

  const logMessage = `[config/io] ${operation} failed for ${path}: ${message} (${category})`;

  switch (level) {
    case "debug":
      logger.debug(logMessage, context);
      break;
    case "warn":
      logger.warn(logMessage, context);
      break;
    case "error":
      logger.error(logMessage, context);
      break;
  }
}