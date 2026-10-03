import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("env");

function formatEnvValue(value: string, redact?: boolean): string {
  if (redact) {
    return "<redacted>";
  }
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 160) {
    return singleLine;
  }
  return `${truncateUtf16Safe(singleLine, 160)}…`;
}

export function logAcceptedEnvValue(
  key: string,
  value: string,
  description: string,
  redact?: boolean,
): void {
  log.info(`env: ${key}=${formatEnvValue(value, redact)} (${description})`);
}
