import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";

export function isMeetingBrowserTransientNavigationError(error: unknown): boolean {
  return /execution context was destroyed.*navigation|cannot find context with specified id/i.test(
    coerceErrorMessage(error),
  );
}
