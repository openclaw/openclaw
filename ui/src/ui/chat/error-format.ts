const HTTP_STATUS_PREFIX_RE = /^(\d{3})\s+([\s\S]+)$/;

function parseApiErrorInfo(input: string): {
  httpCode?: string;
  type?: string;
  message?: string;
  requestId?: string;
} | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  let httpCode: string | undefined;
  let payloadText = trimmed;

  const httpMatch = trimmed.match(HTTP_STATUS_PREFIX_RE);
  if (httpMatch) {
    httpCode = httpMatch[1];
    payloadText = httpMatch[2].trim();
  }

  if (!payloadText.startsWith("{")) {
    return {
      httpCode,
      message: payloadText,
    };
  }

  try {
    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    const topType = typeof payload.type === "string" ? payload.type : undefined;
    const topMessage = typeof payload.message === "string" ? payload.message : undefined;
    const requestId =
      typeof payload.request_id === "string"
        ? payload.request_id
        : typeof payload.requestId === "string"
          ? payload.requestId
          : undefined;

    let errType: string | undefined;
    let errMessage: string | undefined;

    if (payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)) {
      const err = payload.error as Record<string, unknown>;
      if (typeof err.type === "string") {
        errType = err.type;
      }
      if (typeof err.code === "string" && !errType) {
        errType = err.code;
      }
      if (typeof err.message === "string") {
        errMessage = err.message;
      }
    }

    return {
      httpCode,
      type: errType ?? topType,
      message: errMessage ?? topMessage,
      requestId,
    };
  } catch {
    return {
      httpCode,
      message: payloadText,
    };
  }
}

// Keep output aligned with TUI's formatter semantics.
export function formatRawAssistantErrorForUi(raw?: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return "LLM request failed with an unknown error.";
  }

  const httpMatch = trimmed.match(HTTP_STATUS_PREFIX_RE);
  if (httpMatch) {
    const rest = httpMatch[2].trim();
    if (!rest.startsWith("{")) {
      return `HTTP ${httpMatch[1]}: ${rest}`;
    }
  }

  const info = parseApiErrorInfo(trimmed);
  if (info?.message) {
    const prefix = info.httpCode ? `HTTP ${info.httpCode}` : "LLM error";
    const type = info.type ? ` ${info.type}` : "";
    const requestId = info.requestId ? ` (request_id: ${info.requestId})` : "";
    return `${prefix}${type}: ${info.message}${requestId}`;
  }

  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}
