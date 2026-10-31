import {
  buildOAuthRefreshFailureLoginCommand,
  type OAuthRefreshFailureReason,
} from "../agents/auth-profiles/oauth-refresh-failure.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import { resolveSafeProviderId } from "../agents/failover/user-copy.js";
import type { ModelAuthRefreshOutcome } from "../commands/models/auth-refresh.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MessagePresentation } from "../interactive/payload.js";
import {
  resolveProviderChannelLoginChoice,
  type ProviderChannelLoginChoice,
} from "../plugins/provider-login-options.js";
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
  return `${choice.providerLabel} login did not complete. Send \`${formatProviderLoginCommand(choice.command)}\` to try again.`;
}

export type ProviderLoginRecoveryEvidence = {
  provider?: string;
  oauthReason?: OAuthRefreshFailureReason | null;
  failoverReason?: FailoverReason;
  authMode?: string;
};

export type ProviderLoginRecovery = {
  hint: string;
  presentation: MessagePresentation;
};

/**
 * Tappable sign-in buttons for an unauthenticated provider: one button per
 * declared login route (for example subscription OAuth versus API key).
 * Unlike buildProviderLoginRecovery (which requires OAuth evidence), this is
 * keyed by the failure's provider name, so it only offers routes that channel
 * login resolution actually returns for that provider; an unsupported
 * resolution yields no buttons rather than a dead-end `/login` command.
 * Callers should pass the runtime config when available so disabled-plugin
 * settings are honored exactly as `/login` honors them. Chat clients cannot
 * copy bare commands easily, so failure copy must never rely on typed
 * commands alone.
 */
export function buildProviderAuthLoginPresentation(
  provider?: string,
  config?: OpenClawConfig,
): MessagePresentation | undefined {
  const safeProvider = resolveSafeProviderId(provider);
  if (!safeProvider) {
    return undefined;
  }
  let choices: ProviderChannelLoginChoice[] | undefined;
  try {
    const resolution = resolveProviderChannelLoginChoice(
      safeProvider,
      config ? { config } : undefined,
    );
    choices =
      resolution.status === "resolved"
        ? [resolution.choice]
        : resolution.status === "ambiguous"
          ? resolution.choices
          : undefined;
  } catch {
    choices = undefined;
  }
  if (!choices || choices.length === 0) {
    return undefined;
  }
  const buttons = choices.slice(0, 4).map((choice) => ({
    label:
      choice.mode === "chat" || choice.mode === "sign-in"
        ? `Sign in — ${choice.label}`
        : choice.label,
    action: {
      type: "command" as const,
      command: formatProviderLoginCommand(choice.command),
    },
  }));
  return { blocks: [{ type: "buttons", buttons }] };
}

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
    evidence.oauthReason != null ||
    (evidence.authMode === "oauth" &&
      evidence.failoverReason !== undefined &&
      AUTH_PROFILE_LOGIN_REASONS.has(evidence.failoverReason));
  if (!needsLogin) {
    return undefined;
  }
  const command = buildOAuthRefreshFailureLoginCommand(evidence.provider, { surface: "chat" });
  return {
    hint: `Your model provider needs a new login. Send \`${command}\` from a private chat or Control UI session. Where shown, you can also select **Sign in**.`,
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
