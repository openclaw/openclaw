import {
  buildOAuthRefreshFailureLoginCommand,
  type OAuthRefreshFailureReason,
} from "../agents/auth-profiles/oauth-refresh-failure.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import type { ModelAuthRefreshOutcome } from "../commands/models/auth-refresh.js";
import type { MessagePresentation } from "../interactive/payload.js";
import {
  readProviderAuthFailure,
  type ProviderAuthFailure,
} from "../plugins/provider-auth-failure.js";
import type { ProviderChannelLoginChoice } from "../plugins/provider-login-options.js";
import {
  ProviderAuthConfigApplyError,
  ProviderCredentialsSavedError,
} from "../shared/provider-auth-result.js";
import { formatProviderLoginCommand } from "../shared/provider-login-command.js";

export function formatProviderLoginCompletion(
  choice: ProviderChannelLoginChoice,
  authRefresh: ModelAuthRefreshOutcome,
  sessionSwitchFailed = false,
  selection?: { model: string; profileId: string },
): string {
  const sessionFailure = selection
    ? `This chat kept its previous account. To use the new sign-in, send \`/model ${JSON.stringify(`${choice.providerId}/${selection.model}`)}@${JSON.stringify(selection.profileId)} -s\`.`
    : "This chat kept its previous account. Send /models to review the available models.";
  if (authRefresh === "refreshed") {
    return sessionSwitchFailed
      ? `${choice.providerLabel} login complete. ${sessionFailure}`
      : `${choice.providerLabel} login complete. Try your request again now.`;
  }
  const message = `${choice.providerLabel} credentials are saved. Sign-in status could not be confirmed. Send /login refresh to update it; you do not need to sign in again.`;
  return sessionSwitchFailed ? `${message} ${sessionFailure}` : message;
}

/** Chat cannot collect typed input; the chat sign-in prompter throws this for any prompt. */
export const PROVIDER_LOGIN_NEEDS_APP =
  "This provider needs input that chat cannot collect. Open Models in the OpenClaw app and choose Sign in.";

const OPEN_APP = "Open Models in the OpenClaw app and choose Sign in.";

/** The chat renderer for a failed `/login`: never a terminal command. */
export function formatProviderLoginFailure(
  choice: ProviderChannelLoginChoice,
  error: unknown,
): string {
  if (error instanceof ProviderAuthConfigApplyError) {
    return `${choice.providerLabel} credentials are saved, but the connection settings could not be applied. Open Models to review the connection settings and try again.`;
  }
  if (error instanceof ProviderCredentialsSavedError) {
    return `Some ${choice.providerLabel} sign-in details were saved, but setup is incomplete. Open Models to review the saved connection and finish setup.`;
  }
  if (error instanceof Error && error.message === PROVIDER_LOGIN_NEEDS_APP) {
    return PROVIDER_LOGIN_NEEDS_APP;
  }
  const retry = `Send \`${formatProviderLoginCommand(choice.command)}\` to try again.`;
  const failure = readProviderAuthFailure(error);
  if (!failure) {
    return `${choice.providerLabel} login did not complete. ${retry}`;
  }
  const next = {
    retry,
    restart: retry,
    "fix-paste": OPEN_APP,
    "open-settings": OPEN_APP,
    wait: `Wait a few minutes, then ${retry.charAt(0).toLowerCase()}${retry.slice(1)}`,
    admin: "Ask your administrator to allow this sign-in.",
  }[failure.recovery];
  return `${choice.providerLabel}: ${failure.message} ${next}`;
}

export type ProviderLoginRecoveryEvidence = {
  provider?: string;
  providerAuthFailure?: ProviderAuthFailure;
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
  const failureRecovery = evidence.providerAuthFailure?.recovery;
  const needsLogin =
    failureRecovery === "restart" ||
    failureRecovery === "retry" ||
    (failureRecovery === undefined && evidence.oauthReason != null) ||
    (evidence.authMode === "oauth" &&
      evidence.failoverReason !== undefined &&
      AUTH_PROFILE_LOGIN_REASONS.has(evidence.failoverReason));
  if (!needsLogin) {
    return undefined;
  }
  const command = buildOAuthRefreshFailureLoginCommand(evidence.provider, { surface: "chat" });
  return {
    // Plain text: error surfaces show it verbatim; channels with buttons add the Sign in action.
    hint: `Your model provider needs a new login. Send ${command} from a private chat or the OpenClaw app.`,
    presentation: {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Sign in",
              action: { type: "command", command },
            },
          ],
        },
      ],
    },
  };
}
