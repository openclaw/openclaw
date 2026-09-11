import type { OAuthRefreshFailureReason } from "../agents/auth-profiles/oauth-refresh-failure.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import type { MessagePresentation } from "../interactive/payload.js";

export type ProviderLoginRecoveryEvidence = {
  oauthReason?: OAuthRefreshFailureReason | null;
  failoverReason?: FailoverReason;
  authMode?: string;
};

export type ProviderLoginRecovery = {
  hint: string;
  presentation: MessagePresentation;
};

const AUTH_PROFILE_LOGIN_REASONS = new Set<FailoverReason>([
  "auth",
  "auth_permanent",
  "session_expired",
]);

/** Builds login recovery only from OAuth evidence, never from a provider name alone. */
export function buildProviderLoginRecovery(
  evidence: ProviderLoginRecoveryEvidence,
): ProviderLoginRecovery | undefined {
  const needsLogin =
    evidence.oauthReason !== null && evidence.oauthReason !== undefined
      ? true
      : evidence.authMode === "oauth" &&
        evidence.failoverReason !== undefined &&
        AUTH_PROFILE_LOGIN_REASONS.has(evidence.failoverReason);
  if (!needsLogin) {
    return undefined;
  }
  return {
    hint: "Your model provider needs a new login. Send `/login` from a private chat or Control UI session. Where shown, you can also select **Sign in**.",
    presentation: {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Sign in",
              action: { type: "command", command: "/login" },
            },
          ],
        },
      ],
    },
  };
}
