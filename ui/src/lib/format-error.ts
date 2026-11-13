import {
  collectErrorGraphCandidates,
  formatErrorMessage,
  readErrorCauses,
  stringifyNonErrorCause,
} from "@openclaw/normalization-core/error-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { redactToolDetail } from "./browser-redact.ts";
import {
  isProgrammingError,
  readErrorDisplayOverride,
  reportProgrammingError,
} from "./connection-error.ts";

export { UserFacingError } from "./connection-error.ts";

/** Formats a failure for display; programming errors are diagnostics, not UI text. */
export function formatUiError(error: unknown, fallback = ""): string {
  const override = readErrorDisplayOverride(error, fallback);
  if (override !== undefined) {
    return override;
  }
  // A wrapper keeps its own message and its other causes.
  let message = formatErrorMessage(error);
  for (const cause of collectErrorGraphCandidates(error, readErrorCauses)) {
    if (isProgrammingError(cause)) {
      if (typeof error === "object" && error !== null) {
        reportProgrammingError(error);
      }
      message = message.replace(` | ${cause.message}`, "");
    }
  }
  return redactToolDetail(message) || fallback;
}

/** Technical details are opt-in and redacted, never replaced by recovery copy. */
export function formatUiErrorDetails(error: unknown): string {
  const message = formatErrorMessage(error);
  const details = asNullableRecord(error)?.details;
  return redactToolDetail(
    details == null ? message : `${message}\n${stringifyNonErrorCause(details)}`,
  );
}

export function formatUiExternalText(value: string | null | undefined, fallback = ""): string {
  const text = value?.trim();
  return text ? redactToolDetail(text) : fallback;
}
