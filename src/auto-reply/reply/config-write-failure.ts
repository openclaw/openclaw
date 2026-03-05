import { formatConfigWriteFailureForChannel } from "../../config/config.js";

export function formatConfigWriteFailureText(error: unknown): string {
  const formatted = formatConfigWriteFailureForChannel(error);
  if (formatted) {
    return formatted;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `⚠️ Config update failed: ${message}`;
}
