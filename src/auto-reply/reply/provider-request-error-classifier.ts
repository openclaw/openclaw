// Classifies provider request failures into retry and user-facing categories.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  AUTH_INVALID_TOKEN_USER_TEXT,
  classifyProviderRuntimeFailureKind,
} from "../../agents/embedded-agent-helpers.js";
import { formatErrorMessage } from "../../infra/errors.js";

/** Provider request error classes that get a specialized user-facing reply. */
export type ProviderRequestErrorCode =
  | "provider_authentication_error"
  | "provider_conversation_state_error"
  | "provider_internal_error"
  | "provider_rate_limit_or_quota_error";

/** Structured provider error classification for reply failure handling. */
export type ProviderRequestErrorClassification = {
  code: ProviderRequestErrorCode;
  userMessage: string;
  technicalMessage: string;
};

/** User-facing copy for provider-side broken conversation state. */
export const PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE =
  "⚠️ The model provider rejected the conversation state. Please try again, or use /new to start a fresh session.";

export const PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE =
  "⚠️ The model provider returned HTTP 429 before replying. This can mean rate limiting, exhausted quota, or an account balance/billing issue. Check the selected provider/model, API key, and provider billing/quota dashboard, then try again.";

export const PROVIDER_INTERNAL_ERROR_USER_MESSAGE =
  "⚠️ The model provider returned a temporary internal error before replying. Try again in a moment, or switch to another model if it keeps happening.";

export const PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE = `⚠️ ${AUTH_INVALID_TOKEN_USER_TEXT}`;

/** Classifies provider request failures that are actionable for users. */
export function classifyProviderRequestError(
  err: unknown,
): ProviderRequestErrorClassification | undefined {
  const technicalMessage = formatErrorMessage(err);
  if (classifyProviderRuntimeFailureKind(technicalMessage) === "auth_invalid_token") {
    return {
      code: "provider_authentication_error",
      userMessage: PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE,
      technicalMessage,
    };
  }
  if (
    hasHttp429Evidence(err, technicalMessage) &&
    isGenericProviderRuntimeErrorMessage(technicalMessage)
  ) {
    return {
      code: "provider_rate_limit_or_quota_error",
      userMessage: PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE,
      technicalMessage,
    };
  }
  if (isProviderConversationStateErrorMessage(technicalMessage)) {
    return {
      code: "provider_conversation_state_error",
      userMessage: PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
      technicalMessage,
    };
  }
  if (isProviderInternalErrorMessage(technicalMessage)) {
    return {
      code: "provider_internal_error",
      userMessage: PROVIDER_INTERNAL_ERROR_USER_MESSAGE,
      technicalMessage,
    };
  }
  return undefined;
}

/** Detects provider errors that indicate invalid conversation/tool turn state. */
export function isProviderConversationStateErrorMessage(message: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(message);
  return (
    (lower.includes("custom tool call output is missing") && lower.includes("call id")) ||
    (lower.includes("toolresult") &&
      lower.includes("tooluse") &&
      lower.includes("exceeds the number") &&
      lower.includes("previous turn")) ||
    lower.includes("function call turn comes immediately after") ||
    lower.includes("incorrect role information") ||
    lower.includes("roles must alternate") ||
    lower.includes("invalid_replay_transcript")
  );
}

function isGenericProviderRuntimeErrorMessage(message: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(message);
  return (
    lower.includes("an error occurred while processing your request") ||
    lower.includes("something went wrong while processing your request")
  );
}

function isProviderInternalErrorMessage(message: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(message);
  return (
    lower.includes("the ai service returned an internal error") ||
    lower.includes("provider returned an internal error") ||
    (isGenericProviderRuntimeErrorMessage(message) &&
      (lower.includes("server_error") || lower.includes("internal error")))
  );
}

function hasHttp429Evidence(err: unknown, message: string): boolean {
  return (
    readHttp429Status(err) ||
    /\b(?:http\s*)?429\b|["'](?:status|code)["']\s*:\s*429\b/iu.test(message)
  );
}

function readHttp429Status(err: unknown, seen = new Set<unknown>()): boolean {
  if (!err || typeof err !== "object" || seen.has(err)) {
    return false;
  }
  seen.add(err);
  const candidate =
    (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    if (candidate === 429) {
      return true;
    }
  } else if (typeof candidate === "string" && Number(candidate.trim()) === 429) {
    return true;
  }
  const nested = err as { cause?: unknown; error?: unknown; response?: unknown };
  return (
    readHttp429Status(nested.response, seen) ||
    readHttp429Status(nested.error, seen) ||
    readHttp429Status(nested.cause, seen)
  );
}
