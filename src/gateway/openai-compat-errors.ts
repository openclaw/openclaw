import type { FailoverReason } from "../agents/embedded-agent-helpers/types.js";
import { describeFailoverError, resolveFailoverStatus } from "../agents/failover-error.js";

export type OpenAiCompatError = {
  /** HTTP status code to use for the OpenAI-compatible response. */
  status: number;
  error: {
    /** Client-facing error message. */
    message: string;
    /** OpenAI-compatible error type. */
    type: string;
    /** Optional provider/failover error code when available. */
    code?: string;
  };
};

const ERROR_TYPE_BY_REASON: Partial<Record<FailoverReason, string>> = {
  auth: "authentication_error",
  auth_permanent: "permission_error",
  billing: "insufficient_quota",
  format: "invalid_request_error",
  model_not_found: "invalid_request_error",
  overloaded: "api_error",
  rate_limit: "rate_limit_error",
  server_error: "api_error",
  session_expired: "invalid_request_error",
  timeout: "api_error",
};

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

export function resolveOpenAiCompatError(err: unknown): OpenAiCompatError | undefined {
  // Only dependency-classified failover errors become OpenAI-compatible
  // payloads; unknown local failures stay with endpoint-specific 500 handling.
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
      message,
      type,
      ...(described.code ? { code: described.code } : {}),
    },
  };
}

/** Validates OpenAI-compatible sampling values before forwarding them to providers. */
export function validateOpenAiSamplingParams(params: {
  /** OpenAI temperature value; valid range is 0 through 2. */
  temperature?: unknown;
  /** OpenAI top_p value; valid range is 0 through 1. */
  topP?: unknown;
  /** OpenAI frequency_penalty value; valid range is -2 through 2. */
  frequencyPenalty?: unknown;
  /** OpenAI presence_penalty value; valid range is -2 through 2. */
  presencePenalty?: unknown;
  /** OpenAI seed value; must be a finite integer when provided. */
  seed?: unknown;
}): string | undefined {
  // Keep validation at the HTTP compatibility boundary so provider runtimes see
  // OpenAI-shaped sampling values only after range/type checks have passed.
  if (params.temperature != null) {
    if (typeof params.temperature !== "number" || !Number.isFinite(params.temperature)) {
      return "`temperature` must be a finite number.";
    }
    if (params.temperature < 0 || params.temperature > 2) {
      return "`temperature` must be between 0 and 2.";
    }
  }
  if (params.topP != null) {
    if (typeof params.topP !== "number" || !Number.isFinite(params.topP)) {
      return "`top_p` must be a finite number.";
    }
    if (params.topP < 0 || params.topP > 1) {
      return "`top_p` must be between 0 and 1.";
    }
  }
  if (params.frequencyPenalty != null) {
    if (typeof params.frequencyPenalty !== "number" || !Number.isFinite(params.frequencyPenalty)) {
      return "`frequency_penalty` must be a finite number.";
    }
    if (params.frequencyPenalty < -2 || params.frequencyPenalty > 2) {
      return "`frequency_penalty` must be between -2.0 and 2.0.";
    }
  }
  if (params.presencePenalty != null) {
    if (typeof params.presencePenalty !== "number" || !Number.isFinite(params.presencePenalty)) {
      return "`presence_penalty` must be a finite number.";
    }
    if (params.presencePenalty < -2 || params.presencePenalty > 2) {
      return "`presence_penalty` must be between -2.0 and 2.0.";
    }
  }
  if (params.seed != null) {
    if (typeof params.seed !== "number" || !Number.isFinite(params.seed)) {
      return "`seed` must be a finite number.";
    }
    if (!Number.isInteger(params.seed)) {
      return "`seed` must be an integer.";
    }
  }
  return undefined;
}
