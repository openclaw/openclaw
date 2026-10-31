import { createHash } from "node:crypto";

export const INSTALLATION_COUNT_HEADER = "OpenClaw-Installation-Count";
export const INSTALLATION_COUNT_USER_AGENT = "openclaw-installation-count/1";
const MAX_UTC_DAY = 99_999_999;

export function parseInstallationCountCapability(value: string | null): number | null {
  const match = /^1;(0|[1-9][0-9]{0,7})$/.exec(value ?? "");
  // Comparing the full match also refuses JavaScript's end-anchor exception for a final newline.
  return match && match[0] === value ? Number(match[1]) : null;
}

export function installationCountStateKey(endpoint: string): string {
  // This endpoint-only hash is identical for everyone and never leaves local storage.
  return "telemetry.installationCount." + createHash("sha256").update(endpoint).digest("hex");
}

export function buildInstallationCountHeader(day: number, lastAttemptDay: unknown): string | null {
  if (!Number.isSafeInteger(day) || day < 0 || day > MAX_UTC_DAY) {
    return null;
  }
  if (lastAttemptDay === undefined) {
    return "1;" + day + ";31";
  }
  if (
    typeof lastAttemptDay !== "number" ||
    !Number.isSafeInteger(lastAttemptDay) ||
    lastAttemptDay < 0 ||
    lastAttemptDay >= day
  ) {
    // Corruption and receiver-day rollback fail closed rather than issuing duplicate reports.
    return null;
  }
  return "1;" + day + ";" + Math.min(31, day - lastAttemptDay);
}
