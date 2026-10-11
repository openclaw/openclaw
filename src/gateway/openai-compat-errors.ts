// OpenAI-compatible error helpers.
// Converts OpenClaw failover/sampling errors to OpenAI-style HTTP responses.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentStreamParams } from "../agents/command/shared-types.js";
import { describeFailoverError, resolveFailoverStatus } from "../agents/failover-error.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import { ToolAuthorizationError } from "../agents/tool-input-error.js";
import { redactToolPayloadText } from "../logging/redact.js";

export type OpenAiCompatError = {
  status: number;
  error: {
    message: string;
    type: string;
    code?: string;
  };
};

const ERROR_TYPE_BY_REASON = {
  auth: "authentication_error",
  auth_permanent: "permission_error",
  format: "invalid_request_error",
  rate_limit: "rate_limit_error",
  overloaded: "api_error",
  billing: "insufficient_quota",
  server_error: "api_error",
  timeout: "api_error",
  tls_certificate: "api_error",
  context_overflow: "invalid_request_error",
  model_not_found: "invalid_request_error",
  session_expired: "invalid_request_error",
  empty_response: undefined,
  no_error_details: undefined,
  unclassified: undefined,
  unknown: undefined,
} satisfies Record<FailoverReason, string | undefined>;

/** Converts a provider failover error into an OpenAI-compatible error envelope. */
export function resolveOpenAiCompatError(err: unknown): OpenAiCompatError | undefined {
  // Name check instead of instanceof: bundling can duplicate the class across
  // chunks, and clients need the 503 envelope rather than masked content.
  if (err instanceof Error && err.name === "GatewayDrainingError") {
    return {
      status: 503,
      error: {
        message: err.message,
        type: "service_unavailable",
        code: "gateway_unavailable",
      },
    };
  }
  if (err instanceof ToolAuthorizationError) {
    return { status: 403, error: { message: err.message, type: "permission_error" } };
  }
  const described = describeFailoverError(err);
  const reason = described.reason;
  if (!reason) {
    return undefined;
  }
  const type = ERROR_TYPE_BY_REASON[reason];
  if (!type) {
    return undefined;
  }
  let status = described.status ?? resolveFailoverStatus(reason) ?? 500;
  let message: string;
  if (reason === "server_error" || reason === "timeout") {
    status =
      described.status && described.status >= 400 && described.status < 500
        ? described.status
        : reason === "timeout"
          ? 504
          : 502;
    message = reason === "timeout" ? "upstream provider timeout" : "upstream provider error";
  } else {
    message =
      reason === "overloaded"
        ? "upstream provider overloaded"
        : described.rawError?.trim() || described.message.trim() || "request failed";
  }
  return {
    status,
    error: {
      message: redactToolPayloadText(message),
      type,
      ...(described.code ? { code: redactToolPayloadText(described.code) } : {}),
    },
  };
}

/** Validates sampling ranges after the HTTP request schema admits numeric fields. */
export function validateOpenAiSamplingParams(params: {
  temperature?: number | null;
  topP?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  seed?: number | null;
}): string | undefined {
  if (params.temperature != null && (params.temperature < 0 || params.temperature > 2)) {
    return "`temperature` must be between 0 and 2.";
  }
  if (params.topP != null && (params.topP < 0 || params.topP > 1)) {
    return "`top_p` must be between 0 and 1.";
  }
  if (
    params.frequencyPenalty != null &&
    (params.frequencyPenalty < -2 || params.frequencyPenalty > 2)
  ) {
    return "`frequency_penalty` must be between -2.0 and 2.0.";
  }
  if (
    params.presencePenalty != null &&
    (params.presencePenalty < -2 || params.presencePenalty > 2)
  ) {
    return "`presence_penalty` must be between -2.0 and 2.0.";
  }
  if (params.seed != null && !Number.isInteger(params.seed)) {
    return "`seed` must be an integer.";
  }
  return undefined;
}

export function resolveOpenAiStreamParams(
  params: AgentStreamParams,
): AgentStreamParams | undefined {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function resolveResponseFormat(value: unknown): Record<string, unknown> | undefined {
  if (value == null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("response_format must be an object");
  }
  const type = value.type;
  if (type !== "text" && type !== "json_object" && type !== "json_schema") {
    throw new Error("response_format.type must be text, json_object, or json_schema");
  }
  return value;
}

export function resolveStopSequences(
  value: string | string[] | null | undefined,
): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  const list = typeof value === "string" ? [value] : value;
  // OpenAI Chat Completions accepts at most 4 stop sequences.
  if (list.length > 4) {
    throw new Error("stop supports at most 4 sequences");
  }
  if (list.some((item) => item.length === 0)) {
    throw new Error("stop entries must be non-empty strings");
  }
  return list.length > 0 ? list : undefined;
}
