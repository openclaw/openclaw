import { normalizeOptionalString } from "../shared/string-coerce.js";

export const CRON_CUSTOM_JOB_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";

const cronCustomJobIdRegex = new RegExp(CRON_CUSTOM_JOB_ID_PATTERN);

export function normalizeOptionalCronJobId(value: unknown): string | undefined {
  return normalizeOptionalString(value) ?? undefined;
}

export function assertSafeCronCustomJobId(value: string): string {
  const normalized = normalizeOptionalCronJobId(value) ?? "";
  if (!normalized || !cronCustomJobIdRegex.test(normalized)) {
    throw new Error(
      "invalid cron job id: use 1-128 letters, numbers, dots, underscores, or hyphens, starting with an alphanumeric character",
    );
  }
  return normalized;
}
