// One typed provider sign-in failure. Plugins name what went wrong; core owns what the user
// does next and how each surface (CLI, Control UI, chat) says it.

/** What the user does next. Core decides this from the reason; plugins never choose it. */
export type ProviderAuthRecovery =
  | "retry"
  | "restart"
  | "fix-paste"
  | "open-settings"
  | "wait"
  | "admin";

/** Core default recovery and sentence for each reason. */
const FAILURES = {
  consent_denied: [
    "retry",
    "Sign-in was not allowed. Go back to the sign-in page and allow access.",
  ],
  admin_blocked: ["admin", "Your organization does not allow this sign-in."],
  device_code_expired: ["restart", "The sign-in code expired before it was approved."],
  device_code_denied: ["restart", "The sign-in code was denied."],
  paste_wrong_attempt: [
    "fix-paste",
    "This address belongs to a different sign-in attempt. Use the link from this sign-in.",
  ],
  paste_sign_in_page: [
    "fix-paste",
    "That is the sign-in page. Finish signing in there, then paste the address your browser opens afterwards.",
  ],
  paste_no_code: [
    "fix-paste",
    "Paste the address your browser opened after sign-in, including everything after the ?",
  ],
  callback_port_busy: [
    "open-settings",
    "The sign-in callback could not start because its port is in use.",
  ],
  secure_origin_unavailable: [
    "open-settings",
    "Browser sign-in needs OpenClaw open on an HTTPS address or on this computer's local address.",
  ],
  relay_denied: ["open-settings", "The paired device did not accept the sign-in."],
  grant_rejected: ["restart", "The provider rejected this sign-in."],
  client_misconfigured: ["admin", "The provider rejected OpenClaw's sign-in configuration."],
  scope_missing: ["restart", "Sign-in finished without the permission OpenClaw needs."],
  network: ["restart", "The connection to the provider failed during sign-in."],
  provider_unavailable: ["wait", "The provider is temporarily unavailable."],
  rate_limited: ["wait", "The provider is limiting sign-in requests."],
  timed_out: ["restart", "Sign-in timed out."],
  host_network_blocked: [
    "open-settings",
    "The network of the computer running OpenClaw blocked the connection to the provider.",
  ],
  refresh_rejected: ["restart", "This sign-in has ended or was rejected."],
  account_unavailable: ["admin", "The provider does not allow this account to be used."],
} as const satisfies Record<string, readonly [ProviderAuthRecovery, string]>;

export type ProviderAuthFailureReason = keyof typeof FAILURES;

/** Core-owned recovery for a reason; the Control UI reads it to pick its one action. */
export function resolveProviderAuthRecovery(
  reason: ProviderAuthFailureReason,
): ProviderAuthRecovery {
  return FAILURES[reason][0];
}

export function isProviderAuthFailureReason(value: unknown): value is ProviderAuthFailureReason {
  return typeof value === "string" && Object.hasOwn(FAILURES, value);
}

/**
 * A provider sign-in or saved-credential failure. `providerDetail` is one bounded,
 * provider-worded sentence with no commands; without it the message is core's sentence.
 */
export class ProviderAuthFailure extends Error {
  readonly reason: ProviderAuthFailureReason;
  readonly recovery: ProviderAuthRecovery;
  readonly providerDetail?: string;
  readonly retryAfterMs?: number;

  constructor(
    reason: ProviderAuthFailureReason,
    options: { providerDetail?: string; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(options.providerDetail ?? FAILURES[reason][1], { cause: options.cause });
    this.name = "ProviderAuthFailure";
    this.reason = reason;
    this.recovery = FAILURES[reason][0];
    if (options.providerDetail) {
      this.providerDetail = options.providerDetail;
    }
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

/** Maps an RFC 6749 `error=` value from a redirect, callback or paste to its failure. */
export function providerAuthFailureFromOAuthError(error: string): ProviderAuthFailure {
  switch (error) {
    case "admin_policy_enforced":
    case "org_internal":
      return new ProviderAuthFailure("admin_blocked");
    case "server_error":
    case "temporarily_unavailable":
      return new ProviderAuthFailure("provider_unavailable");
    case "invalid_client":
    case "invalid_request":
    case "invalid_scope":
    case "unauthorized_client":
    case "unsupported_response_type":
      return new ProviderAuthFailure("client_misconfigured");
    default:
      return new ProviderAuthFailure("consent_denied");
  }
}

/**
 * Finds the typed failure in an error and its causes. Plugins published against an SDK
 * without this class (the Gemini plugin's 2026.10.3 floor) throw an Error named
 * `ProviderAuthFailure` with the same fields; those are read by shape.
 */
export function readProviderAuthFailure(error: unknown): ProviderAuthFailure | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof ProviderAuthFailure) {
      return current;
    }
    // SAFETY: every field is optional and each one is type-checked below before use.
    const facts = current as Error & {
      reason?: unknown;
      providerDetail?: unknown;
      retryAfterMs?: unknown;
    };
    if (current.name === "ProviderAuthFailure" && isProviderAuthFailureReason(facts.reason)) {
      return new ProviderAuthFailure(facts.reason, {
        providerDetail:
          typeof facts.providerDetail === "string" ? facts.providerDetail : current.message,
        ...(typeof facts.retryAfterMs === "number" ? { retryAfterMs: facts.retryAfterMs } : {}),
        cause: current,
      });
    }
    current = current.cause;
  }
  return undefined;
}
