import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Structured provider facts, not a receipt that an owner's durable cleanup completed. */
export type OAuthRefreshOutcome = {
  version: 1;
  status?: number;
  reason?: OAuthRefreshErrorReason;
} & (
  | {
      phase: "before-dispatch";
      outcome: "not-attempted";
      recovery: { kind: "later"; evidence: "dispatch-not-started" };
    }
  | {
      phase: "token-response";
      outcome: "unchanged";
      recovery: {
        kind: "later";
        evidence:
          | "documented-nonconsuming-rejection"
          | "documented-reusable-grant"
          | "owner-accepted-provider-retry"
          | "verified-intermediary-challenge";
      };
    }
  | {
      phase: "before-dispatch" | "token-response" | "after-token-response";
      outcome: "rejected" | "unknown";
      recovery?: never;
    }
);

export type OAuthRefreshErrorReason =
  | "invalid_grant"
  | "revoked"
  | "reused"
  | "expired"
  | "invalid_client"
  | "invalid_scope"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "provider_error";

const terminalReasons = new Set([
  "invalid_grant",
  "revoked",
  "reused",
  "expired",
  "invalid_client",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_grant_type",
  "refresh_token_reused",
  "invalid_refresh_token",
  "token_invalidated",
  "expired_token",
  "sign_in_again",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "bad_refresh_token",
  "incorrect_client_credentials",
]);

function terminalReason(value: unknown): boolean {
  return typeof value === "string" && terminalReasons.has(value);
}

/** Read protocol fields, never prose or a transport code, for rejection precedence. */
export function readOAuthRefreshErrorReason(payload: unknown): OAuthRefreshErrorReason | undefined {
  const record = asOptionalRecord(payload);
  const error = asOptionalRecord(record?.error);
  const reason = [record?.reason, error?.code, error?.reason, record?.error, record?.code].find(
    terminalReason,
  );
  if (typeof reason !== "string") {
    return record?.error ? "provider_error" : undefined;
  }
  switch (reason) {
    case "refresh_token_reused":
      return "reused";
    case "expired_token":
    case "refresh_token_expired":
      return "expired";
    case "incorrect_client_credentials":
      return "invalid_client";
    case "invalid_refresh_token":
    case "bad_refresh_token":
    case "refresh_token_invalidated":
    case "token_invalidated":
    case "sign_in_again":
      return "invalid_grant";
    case "invalid_grant":
    case "revoked":
    case "reused":
    case "expired":
    case "invalid_client":
    case "invalid_scope":
    case "unauthorized_client":
    case "unsupported_grant_type":
      return reason;
    default:
      return undefined;
  }
}

/** Attach bounded, credential-free protocol facts while retaining the original cause. */
export function createOAuthRefreshError(
  message: string,
  outcome: OAuthRefreshOutcome,
  options?: ErrorOptions,
): Error & { oauthRefreshOutcome: OAuthRefreshOutcome } {
  return Object.assign(new Error(message, options), {
    oauthRefreshOutcome: outcome,
    oauthRefreshFailure: { status: outcome.status, reason: outcome.reason },
  });
}

/**
 * Reuse evidence must come from the provider owner, never from status alone.
 * `owner-accepted-provider-retry` is a provider-specific product decision, not a
 * documented reuse guarantee; only the named provider adapter may claim it.
 */
export function createOAuthRefreshResponseError(
  context: string,
  status: number,
  payload: unknown,
  evidence?: "documented-reusable-grant" | "owner-accepted-provider-retry",
): ReturnType<typeof createOAuthRefreshError> {
  const reason = readOAuthRefreshErrorReason(payload);
  const record = asOptionalRecord(payload);
  const reusable =
    evidence && (!reason || reason === "provider_error") && (status === 429 || status >= 500);
  return createOAuthRefreshError(`${context} failed (${status})${reason ? `: ${reason}` : ""}`, {
    version: 1,
    phase: "token-response",
    ...(reusable
      ? { outcome: "unchanged" as const, recovery: { kind: "later" as const, evidence } }
      : {
          outcome:
            reason && reason !== "provider_error" && !record?.access_token
              ? ("rejected" as const)
              : ("unknown" as const),
        }),
    status,
    ...(reason ? { reason } : {}),
  });
}

/** Only positive provider evidence can admit a later attempt with the old refresh grant. */
export function isRecoverableOAuthRefreshFailure(error: unknown): boolean {
  let safe = false;
  for (const candidate of collectNestedErrorCandidates(error)) {
    const record = asOptionalRecord(candidate);
    const presentation = asOptionalRecord(record?.oauthRefreshFailure);
    const reason = readOAuthRefreshErrorReason(record);
    const challenge = asOptionalRecord(record?.oauthRefreshOutcome);
    const verifiedChallenge =
      challenge?.version === 1 &&
      challenge.phase === "token-response" &&
      challenge.outcome === "unchanged" &&
      challenge.status === 403 &&
      asOptionalRecord(challenge.recovery)?.kind === "later" &&
      asOptionalRecord(challenge.recovery)?.evidence === "verified-intermediary-challenge";
    if (
      (reason !== undefined && reason !== "provider_error") ||
      terminalReason(presentation?.reason) ||
      presentation?.retryable === false ||
      [record?.status, presentation?.status].some(
        (status) =>
          typeof status === "number" &&
          status >= 400 &&
          status < 500 &&
          status !== 429 &&
          !(status === 403 && verifiedChallenge),
      )
    ) {
      return false;
    }
    if (record?.oauthRefreshOutcome === undefined) {
      continue;
    }
    const facts = asOptionalRecord(record.oauthRefreshOutcome);
    if (
      !facts ||
      facts.version !== 1 ||
      terminalReason(facts.reason) ||
      (facts.reason !== undefined && facts.reason !== "provider_error") ||
      (facts.status !== undefined &&
        (typeof facts.status !== "number" ||
          !Number.isInteger(facts.status) ||
          facts.status < 100 ||
          facts.status > 599))
    ) {
      return false;
    }
    const recovery = asOptionalRecord(facts.recovery);
    const notAttempted =
      facts.phase === "before-dispatch" &&
      facts.outcome === "not-attempted" &&
      recovery?.evidence === "dispatch-not-started";
    const unchanged =
      (facts.phase === "token-response" &&
        facts.outcome === "unchanged" &&
        (facts.status === undefined ||
          facts.status === 429 ||
          (typeof facts.status === "number" && facts.status >= 500)) &&
        (recovery?.evidence === "documented-nonconsuming-rejection" ||
          recovery?.evidence === "documented-reusable-grant" ||
          recovery?.evidence === "owner-accepted-provider-retry")) ||
      (verifiedChallenge && facts === challenge);
    if (recovery?.kind !== "later" || (!notAttempted && !unchanged)) {
      return false;
    }
    safe = true;
  }
  // Legacy booleans, headers absent, status and transport codes are presentation only.
  return safe;
}
