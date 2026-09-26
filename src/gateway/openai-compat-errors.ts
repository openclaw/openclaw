// OpenAI-compatible error helpers.
// Converts OpenClaw failover/sampling errors to OpenAI-style HTTP responses.
import { describeFailoverError, resolveFailoverStatus } from "../agents/failover-error.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import { ToolAuthorizationError } from "../agents/tool-input-error.js";
import { redactToolPayloadText } from "../logging/redact.js";

type OpenAiCompatError = {
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

function statusForReason(reason: FailoverReason, status: number | undefined): number {
  if (reason === "server_error") {
    return status && status >= 400 && status < 500 ? status : 502;
  }
  if (reason === "timeout") {
    return status && status >= 400 && status < 500 ? status : 504;
  }
  return status ?? resolveFailoverStatus(reason) ?? 500;
}

function messageForReason(params: {
  reason: FailoverReason;
  message: string;
  rawError?: string;
}): string {
  if (params.reason === "server_error") {
    return "upstream provider error";
  }
  if (params.reason === "timeout") {
    return "upstream provider timeout";
  }
  if (params.reason === "overloaded") {
    return "upstream provider overloaded";
  }
  return params.rawError?.trim() || params.message.trim() || "request failed";
}

/** Converts a provider failover error into an OpenAI-compatible error envelope. */
export function resolveOpenAiCompatError(err: unknown): OpenAiCompatError | undefined {
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
  const status = statusForReason(reason, described.status);
  const message = messageForReason({
    reason,
    message: described.message,
    rawError: described.rawError,
  });
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
