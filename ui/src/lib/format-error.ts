import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { redactToolDetail } from "./browser-redact.ts";

/** The message is complete UI text; the cause remains available to diagnostics. */
export class UserFacingError extends Error {}

export function formatUiError(error: unknown, fallback = ""): string {
  if (error instanceof UserFacingError) {
    return redactToolDetail(error.message) || fallback;
  }
  return formatErrorMessage(error, { redact: redactToolDetail }) || fallback;
}

export function formatUiExternalText(value: string | null | undefined, fallback = ""): string {
  const text = value?.trim();
  return text ? redactToolDetail(text) : fallback;
}
