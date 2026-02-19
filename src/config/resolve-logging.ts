import type { LoggingConfig } from "./types.base.js";

/**
 * Resolve logging file path from config (string or object with path).
 */
export function getLoggingFilePath(logging: LoggingConfig | undefined): string {
  if (!logging?.file) return "";
  const f = logging.file;
  if (typeof f === "string") return f.trim();
  if (
    typeof f === "object" &&
    f !== null &&
    "path" in f &&
    typeof (f as { path: unknown }).path === "string"
  ) {
    return (f as { path: string }).path.trim();
  }
  return "";
}

/**
 * Whether log file rotation is requested (when file is specified as object with rotate: true).
 */
export function getLoggingFileRotate(logging: LoggingConfig | undefined): boolean {
  if (!logging?.file || typeof logging.file !== "object" || logging.file === null) return false;
  return Boolean((logging.file as { rotate?: boolean }).rotate);
}
