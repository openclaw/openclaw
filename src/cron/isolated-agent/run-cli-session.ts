/** CLI session helpers for isolated cron prompt execution. */
import type { CliSessionBinding } from "../../config/sessions.js";

/** True when a CLI binding carries reuse metadata beyond its session id. */
export function hasCliSessionReuseMetadata(binding: CliSessionBinding): boolean {
  return Object.entries(binding).some(([key, value]) => key !== "sessionId" && value !== undefined);
}
