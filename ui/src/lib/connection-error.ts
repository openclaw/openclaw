import { readMissingScopeError } from "@openclaw/gateway-client/browser";
import { asNullableRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { redactToolDetail } from "./browser-redact.ts";

/** The message is complete UI text; the cause remains available to diagnostics. */
export class UserFacingError extends Error {}

// SyntaxError stays visible: users can fix invalid JSON. Browser network TypeErrors do too.
const PROGRAMMING_ERROR_NAME = /^(?:Eval|Internal|Range|Reference|Type|URI)Error$/;
const BROWSER_NETWORK_FAILURE =
  /^(?:failed to fetch|load failed|networkerror when|network error|the network connection|the internet connection|importing a module script failed|error loading dynamically imported module)/i;
const GENERIC_FAILURE_MESSAGE = "Request failed";
const reportedProgrammingErrors = new WeakSet<object>();

export function isProgrammingError(value: unknown): value is Error {
  const record = asNullableRecord(value);
  return (
    (value instanceof Error || Object.prototype.toString.call(value) === "[object Error]") &&
    PROGRAMMING_ERROR_NAME.test(readStringField(record, "name") ?? "") &&
    !BROWSER_NETWORK_FAILURE.test(readStringField(record, "message") ?? "")
  );
}

/** Formatting runs on every render, so each thrown value reaches the console once. */
export function reportProgrammingError(error: object): void {
  if (!reportedProgrammingErrors.has(error)) {
    reportedProgrammingErrors.add(error);
    console.error("[control-ui] programming error hidden from the UI:", error);
  }
}

/** Connection decisions need a safe summary even when optional chunks cannot load. */
export function readErrorDisplayOverride(error: unknown, fallback = ""): string | undefined {
  if (error instanceof UserFacingError) {
    return redactToolDetail(error.message) || fallback;
  }
  const missingScope = readMissingScopeError(error);
  if (missingScope) {
    const scope = missingScope.missingScope;
    const access =
      scope === "operator.read"
        ? "read"
        : scope === "operator.write"
          ? "write"
          : scope === "operator.admin"
            ? "admin"
            : "the required";
    return `Couldn’t complete this request. Ask an admin to grant ${access} access.`;
  }
  if (isProgrammingError(error)) {
    reportProgrammingError(error);
    return fallback || GENERIC_FAILURE_MESSAGE;
  }
  return undefined;
}

/** Connection decisions use the outer failure; diagnostic causes stay on the error. */
export function formatConnectionErrorSummary(error: unknown): string {
  const override = readErrorDisplayOverride(error);
  if (override !== undefined) {
    return override;
  }
  const message =
    typeof error === "string" ? error : readStringField(asNullableRecord(error), "message");
  return message ? redactToolDetail(message) : GENERIC_FAILURE_MESSAGE;
}

/** Native bridge failures can retain their full cause text without loading it at boot. */
export async function formatConnectionError(error: unknown): Promise<string> {
  try {
    const { formatUiError } = await import("./format-error.ts");
    return formatUiError(error);
  } catch {
    return formatConnectionErrorSummary(error);
  }
}
