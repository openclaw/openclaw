/**
 * Media failure reasons keep two audiences apart: compact summaries carry only
 * provider status and a bounded code, while diagnostics keep the full message.
 */
type ProviderHttpFailure = { status: number; code?: string; requestId?: string };

// Provider codes are service taxonomy tokens; anything else stays out of summaries.
const SAFE_FAILURE_CODE = /^[A-Za-z0-9_.-]{1,64}$/u;

// Provider errors can cross a module boundary (test/compiled subprocesses), so
// detect their stable shape instead of relying on a single class identity.
function readProviderHttpFailure(error: unknown): ProviderHttpFailure | undefined {
  if (!(error instanceof Error) || error.name !== "ProviderHttpError") {
    return undefined;
  }
  if (!("status" in error) || typeof error.status !== "number") {
    return undefined;
  }
  const rawCode =
    "code" in error && typeof error.code === "string"
      ? error.code
      : "errorType" in error && typeof error.errorType === "string"
        ? error.errorType
        : undefined;
  const code = rawCode && SAFE_FAILURE_CODE.test(rawCode) ? rawCode : undefined;
  const requestId =
    "requestId" in error && typeof error.requestId === "string" ? error.requestId : undefined;
  return {
    status: error.status,
    ...(code ? { code } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

/** Inserts annotations before the message body so compact summaries keep them. */
function annotateReasonHead(reason: string, annotations: readonly string[]): string {
  if (annotations.length === 0) {
    return reason;
  }
  const bodyStart = reason.indexOf(": ");
  const head = bodyStart === -1 ? reason : reason.slice(0, bodyStart);
  const body = bodyStart === -1 ? "" : reason.slice(bodyStart);
  const close = head.lastIndexOf(")");
  const annotated =
    close === -1
      ? `${head} (${annotations.join(" ")})`
      : `${head.slice(0, close)} ${annotations.join(" ")})${head.slice(close + 1)}`;
  return `${annotated}${body}`;
}

/**
 * Diagnostic reason: provider status and code stay in the message head so compact
 * summaries keep them, while response detail and request ids remain trailing text.
 */
export function formatMediaFailureReason(error: unknown): string {
  const failure = readProviderHttpFailure(error);
  if (!failure || !(error instanceof Error)) {
    return String(error);
  }
  // Keep Error#toString's class prefix, but annotate the message head so compact
  // summaries (which strip the prefix) still carry the status and code.
  const toStringValue = String(error);
  const prefixMatch = /^(?:[A-Za-z_$][\w$]*Error): /u.exec(toStringValue);
  const prefix = prefixMatch?.[0] ?? "";
  const reason = toStringValue.slice(prefix.length);
  const bodyStart = reason.indexOf(": ");
  const head = bodyStart === -1 ? reason : reason.slice(0, bodyStart);
  const annotations: string[] = [];
  if (!/\(\s*(?:HTTP\s*)?\d{3}/u.test(head)) {
    annotations.push(`HTTP ${failure.status}`);
  }
  if (failure.code && !head.includes(`code=${failure.code}`)) {
    annotations.push(`code=${failure.code}`);
  }
  const annotated = `${prefix}${annotateReasonHead(reason, annotations)}`;
  return failure.requestId && !annotated.includes(failure.requestId)
    ? `${annotated} [request_id=${failure.requestId}]`
    : annotated;
}

/**
 * Model-facing failure label: provider status plus a bounded code only. Response
 * bodies, request ids, and arbitrary error text stay in their diagnostic path.
 */
export function formatMediaFailureSummary(error: unknown): string | undefined {
  const failure = readProviderHttpFailure(error);
  if (!failure) {
    return undefined;
  }
  const code = failure.code ? ` code=${failure.code}` : "";
  return `provider request failed (HTTP ${failure.status}${code})`;
}
