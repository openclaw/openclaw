import { asOptionalRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { extractHttpResponseBody } from "./http-error-response.js";
const ERROR_PAYLOAD_PREFIX_RE =
  /^(?:error|(?:[a-z][\w-]*\s+)?api\s*error|apierror|openai\s*error|anthropic\s*error|gateway\s*error|codex\s*error)(?:\s+\d{3})?[:\s-]+/i;
const HTTP_STATUS_DELIMITER_RE = /(?:\s*:\s*|\s+)/;
const HTTP_STATUS_PREFIX_RE = new RegExp(
  `^(?:http\\s*)?(\\d{3})${HTTP_STATUS_DELIMITER_RE.source}(.+)$`,
  "i",
);
const HTTP_STATUS_CODE_PREFIX_RE = new RegExp(
  `^(?:http\\s*)?(\\d{3})(?:${HTTP_STATUS_DELIMITER_RE.source}([\\s\\S]+))?$`,
  "i",
);
// Built-in provider adapters format status as `OpenAI API error (500): ...` (also
// Azure OpenAI / Mistral / Provider). Keep this anchored so mid-string numbers
// like model ids or image dimensions never become fake HTTP statuses.
const PROVIDER_WRAPPED_HTTP_STATUS_RE =
  /^(?:[a-z][\w-]*(?:\s+[a-z][\w-]*){0,3}\s+)?api\s*error\s*\((\d{3})\)(?:\s*:\s*([\s\S]*))?$/i;
const LABELED_HTTP_STATUS_RE =
  /^(?:status code|unexpected status|http status)\s*[:=]?\s*(\d{3})\b(?:\s*[:,]?\s*(?:message\s*:\s*)?([\s\S]*))?$/i;
const ERROR_STATUS_ENVELOPE_RE = /^error\s*[:,]\s*/i;
const HTML_ERROR_PREFIX_RE = /^\s*(?:<!doctype\s+html\b|<html\b)/i;
const HTML_CLOSE_RE = /<\/html>/i;
const CLOUDFLARE_HTML_ERROR_CODES = new Set([521, 522, 523, 524, 525, 526, 530]);
const STANDALONE_HTML_ERROR_HINT_RE =
  /\bcloudflare\b|cdn-cgi\/challenge-platform|challenge-error-text|enable javascript and cookies to continue|access denied|forbidden|service unavailable|bad gateway|web server is down|captcha|attention required/i;
const GENERIC_PROVIDER_INTERNAL_ERROR_RE = /an error occurred while processing your request/i;
const SUPPORT_REQUEST_ID_RE = /(?:request[\s_-]*id)\s*[:#]?\s*([a-z0-9][a-z0-9_-]{6,}[a-z0-9])/i;
const GENERIC_PROVIDER_INTERNAL_ERROR_USER_MESSAGE =
  "The AI service returned an internal error. Please try again in a moment.";

export const MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE =
  "OpenClaw transport error: malformed_streaming_fragment";
const MALFORMED_STREAMING_FRAGMENT_USER_MESSAGE =
  "LLM streaming response contained a malformed fragment. Please try again.";

type ErrorPayload = Record<string, unknown>;

type ApiErrorInfo = {
  httpCode?: string;
  type?: string;
  code?: string;
  message?: string;
  requestId?: string;
};

export function formatProviderRefusalText(message: { diagnostics?: unknown }): string | undefined {
  const refusal = Array.isArray(message.diagnostics)
    ? message.diagnostics.find(
        (diagnostic) => asOptionalRecord(diagnostic)?.type === "provider_refusal",
      )
    : undefined;
  if (!refusal) {
    return undefined;
  }
  const category = asOptionalRecord(asOptionalRecord(refusal)?.details)?.category;
  const safeCategory =
    typeof category === "string" && /^[a-z0-9_-]{1,64}$/i.test(category) ? category : undefined;
  if (safeCategory === "misalignment") {
    return "Chat stopped as a precaution. Review the findings in chat before continuing.";
  }
  return `The provider refused this request${safeCategory ? ` (category: ${safeCategory})` : ""}. Revise the request and try again.`;
}

function isErrorPayloadObject(payload: unknown): payload is ErrorPayload {
  const record = asOptionalRecord(payload);
  if (!record) {
    return false;
  }
  if (record.type === "error") {
    return true;
  }
  if (typeof record.request_id === "string" || typeof record.requestId === "string") {
    return true;
  }
  const error = asOptionalRecord(record.error);
  return (
    [error?.message, error?.type, error?.code].some((value) => typeof value === "string") ||
    (typeof record.error === "string" && typeof record.message === "string")
  );
}

export function parseApiErrorPayload(raw?: string): ErrorPayload | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = trimmed.replace(ERROR_PAYLOAD_PREFIX_RE, "").trim();
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return isErrorPayloadObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractHttpStatusMatch(
  match: RegExpMatchArray | null,
): { code: number; rest: string } | null {
  if (!match) {
    return null;
  }
  const code = Number(match[1]);
  if (!Number.isInteger(code) || code < 100 || code > 599) {
    return null;
  }
  return { code, rest: (match[2] ?? "").trim() };
}

export function extractLeadingHttpStatus(raw: string): { code: number; rest: string } | null {
  return extractHttpStatusMatch(raw.match(HTTP_STATUS_CODE_PREFIX_RE));
}

export function extractProviderWrappedHttpStatus(
  raw: string,
): { code: number; rest: string } | null {
  return extractHttpStatusMatch(raw.match(PROVIDER_WRAPPED_HTTP_STATUS_RE));
}

/** Extract an explicitly labeled provider HTTP status without matching embedded numeric text. */
export function extractErrorHttpStatus(raw: string): { code: number; rest: string } | null {
  const candidate = raw.trim().replace(ERROR_STATUS_ENVELOPE_RE, "");
  return (
    extractLeadingHttpStatus(candidate) ??
    extractProviderWrappedHttpStatus(candidate) ??
    extractHttpStatusMatch(candidate.match(LABELED_HTTP_STATUS_RE))
  );
}

export function isCloudflareOrHtmlErrorPage(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }

  if (
    HTML_ERROR_PREFIX_RE.test(trimmed) &&
    HTML_CLOSE_RE.test(trimmed) &&
    STANDALONE_HTML_ERROR_HINT_RE.test(trimmed)
  ) {
    return true;
  }

  const status = extractHttpResponseBody(extractLeadingHttpStatus(trimmed));
  if (!status || status.code < 500) {
    return false;
  }

  if (CLOUDFLARE_HTML_ERROR_CODES.has(status.code)) {
    return true;
  }

  return (
    status.code < 600 && HTML_ERROR_PREFIX_RE.test(status.body) && HTML_CLOSE_RE.test(status.body)
  );
}

export function isGenericProviderInternalError(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  return (
    GENERIC_PROVIDER_INTERNAL_ERROR_RE.test(trimmed) &&
    (/help\.openai\.com/i.test(trimmed) || SUPPORT_REQUEST_ID_RE.test(trimmed))
  );
}

export function parseApiErrorInfo(raw?: string): ApiErrorInfo | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let httpCode: string | undefined;
  let candidate = trimmed;

  const httpPrefix = extractLeadingHttpStatus(candidate);
  if (httpPrefix) {
    httpCode = String(httpPrefix.code);
    candidate = httpPrefix.rest;
  }

  let payload = parseApiErrorPayload(candidate);
  if (!payload) {
    return null;
  }
  // A proxy can wrap the terminal upstream error in its ordered attempt history.
  for (let depth = 0; depth < 4; depth++) {
    const attempts: unknown = asOptionalRecord(payload.error)?.attempts;
    const finalAttempt = Array.isArray(attempts) ? asOptionalRecord(attempts.at(-1)) : undefined;
    const details = finalAttempt?.details;
    if (!isErrorPayloadObject(details)) {
      break;
    }
    payload = details;
  }

  const error = asOptionalRecord(payload.error);
  const errorCode = readStringField(error, "code");
  const errorType = readStringField(error, "type");
  // A nested code also supplies the type when that type is blank or absent.
  const type = error
    ? errorCode !== undefined && !errorType
      ? errorCode
      : errorType
    : readStringField(payload, "error");
  const code = errorCode ?? readStringField(payload, "code");
  return {
    httpCode,
    type: type ?? readStringField(payload, "type"),
    ...(code === undefined ? {} : { code }),
    message: readStringField(error, "message") ?? readStringField(payload, "message"),
    requestId: readStringField(payload, "request_id") ?? readStringField(payload, "requestId"),
  };
}

export function formatRawAssistantErrorForUi(raw?: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return "LLM request failed with an unknown error.";
  }

  if (trimmed === MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE) {
    return MALFORMED_STREAMING_FRAGMENT_USER_MESSAGE;
  }

  if (isGenericProviderInternalError(trimmed)) {
    return GENERIC_PROVIDER_INTERNAL_ERROR_USER_MESSAGE;
  }

  const leadingStatus = extractLeadingHttpStatus(trimmed);
  const isHtmlChallenge = isCloudflareOrHtmlErrorPage(trimmed);
  if (leadingStatus && isHtmlChallenge) {
    return `The AI service is temporarily unavailable (HTTP ${leadingStatus.code}). Please try again in a moment.`;
  }

  if (isHtmlChallenge) {
    return (
      "The provider returned an HTML error page instead of an API response. " +
      "This usually means a CDN or gateway (e.g. Cloudflare) blocked the request. " +
      "Retry in a moment or check provider status."
    );
  }

  const httpMatch = extractHttpStatusMatch(trimmed.match(HTTP_STATUS_PREFIX_RE));
  if (httpMatch) {
    if (!httpMatch.rest.startsWith("{")) {
      return `HTTP ${httpMatch.code}: ${httpMatch.rest}`;
    }
  }

  const info = parseApiErrorInfo(trimmed);
  if (info?.message) {
    const prefix = info.httpCode ? `HTTP ${info.httpCode}` : "LLM error";
    const type = info.type ? ` ${info.type}` : "";
    return `${prefix}${type}: ${info.message}`;
  }

  return trimmed.length > 600 ? `${truncateUtf16Safe(trimmed, 600)}…` : trimmed;
}

const REFUSED_TRANSPORT_CODE_RE = /\beconnrefused\b/i;
const INTERRUPTED_TRANSPORT_CODE_RE = /\beconnreset\b|\beconnaborted\b|\benetreset\b|\bepipe\b/i;
const DNS_TRANSPORT_CODE_RE = /\benotfound\b|\beai_again\b/i;
const UNREACHABLE_TRANSPORT_CODE_RE = /\benetunreach\b|\behostunreach\b|\behostdown\b/i;

export function isKnownTransportErrorCode(value: string): boolean {
  return [
    REFUSED_TRANSPORT_CODE_RE,
    INTERRUPTED_TRANSPORT_CODE_RE,
    DNS_TRANSPORT_CODE_RE,
    UNREACHABLE_TRANSPORT_CODE_RE,
  ].some((pattern) => pattern.exec(value)?.[0] === value);
}

export function formatTransportErrorCopy(raw: string): string | undefined {
  if (!raw || isCloudflareOrHtmlErrorPage(raw)) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if (
    REFUSED_TRANSPORT_CODE_RE.test(raw) ||
    lower.includes("connection refused") ||
    lower.includes("actively refused")
  ) {
    return "OpenClaw couldn't reach the AI service.";
  }
  if (
    INTERRUPTED_TRANSPORT_CODE_RE.test(raw) ||
    lower.includes("socket hang up") ||
    lower.includes("connection reset") ||
    lower.includes("connection aborted")
  ) {
    return "The connection to the AI service was interrupted.";
  }
  if (
    DNS_TRANSPORT_CODE_RE.test(raw) ||
    lower.includes("getaddrinfo") ||
    lower.includes("no such host") ||
    lower.includes("dns")
  ) {
    return "OpenClaw couldn't reach the AI service.";
  }
  if (
    UNREACHABLE_TRANSPORT_CODE_RE.test(raw) ||
    lower.includes("network is unreachable") ||
    lower.includes("host is unreachable")
  ) {
    return "OpenClaw couldn't reach the AI service.";
  }
  if (
    lower.includes("fetch failed") ||
    lower.includes("connection error") ||
    lower.includes("network request failed")
  ) {
    return "OpenClaw couldn't reach the AI service.";
  }
  if (raw.includes("网络错误") || raw.includes("网络异常") || raw.includes("连接错误")) {
    return "The AI service reported a network error.";
  }
  return undefined;
}
