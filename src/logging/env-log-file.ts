import { normalizeOptionalString } from "../shared/string-coerce.js";

export function resolveEnvLogFileOverride(): string | undefined {
  return normalizeOptionalString(process.env.OPENCLAW_LOG_FILE) ?? undefined;
}
