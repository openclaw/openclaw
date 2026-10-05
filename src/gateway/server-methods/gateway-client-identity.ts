import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayClientInfo } from "../../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  getCommandSenderAuthority,
  withCommandSenderAuthority,
} from "../../auto-reply/command-sender-authority.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.types.js";
import type { SessionOperatorScope } from "../../shared/session-method-scopes-base.js";
import { INTERNAL_MESSAGE_CHANNEL, isOperatorUiClient } from "../../utils/message-channel.js";
import { gitHubPublicApi } from "../github-public-api.js";
import { resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import { isSyntheticGatewayCaller } from "./gateway-personal-caller.js";
import type { GatewayClient, GatewayRequestOptions } from "./shared-types.js";

export function isGatewayClientProfilePending(client: GatewayClient | null): boolean {
  return Boolean(client?.authenticatedGitHubIdentitySync && !client.authenticatedUserProfile);
}

/** A GitHub quota failure names its cause and carries GitHub's reset deadline. */
export function authenticatedProfileUnavailableError(cause?: unknown, method?: string): ErrorShape {
  // Only a real GitHub transport error may load the GitHub surface; it can be absent.
  const rateLimited =
    cause instanceof Error &&
    cause.name === "ControlUiGitHubError" &&
    cause instanceof gitHubPublicApi.ControlUiGitHubError &&
    cause.statusCode === 429;
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    rateLimited
      ? "GitHub is rate limiting profile verification. Retry shortly; if this continues, ask a gateway administrator to check the GitHub API credential."
      : "Authenticated profile verification is unavailable. Retry shortly; if this continues, contact a gateway administrator.",
    {
      retryable: true,
      retryAfterMs: (rateLimited && cause.retryAfterMs) || 1_000,
      details: {
        code: ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE,
        ...(method ? { method } : {}),
      },
    },
  );
}

export async function authorizeAuthenticatedProfileForMethod(params: {
  client: GatewayRequestOptions["client"];
  requiresProfile: () => boolean;
  sessionScope?: SessionOperatorScope;
}): Promise<ErrorShape | null> {
  const requiresSessionProfile = params.sessionScope !== undefined;
  const sessionProfileError = () => {
    const actor = resolveGatewayOperatorRoleActor(params.client);
    return requiresSessionProfile && (actor?.kind !== "operator" || !actor.profileId.trim())
      ? errorShape(ErrorCodes.FORBIDDEN, "Session-scoped access requires a verified user profile.")
      : null;
  };
  const sync = params.client?.authenticatedGitHubIdentitySync;
  if (!sync || params.client?.authenticatedUserProfile?.profileId.trim()) {
    return sessionProfileError();
  }
  if (!requiresSessionProfile && !params.requiresProfile()) {
    return null;
  }
  try {
    await sync();
  } catch (error) {
    return authenticatedProfileUnavailableError(error);
  }
  return params.client?.authenticatedUserProfile?.profileId.trim()
    ? sessionProfileError()
    : authenticatedProfileUnavailableError();
}

export function gatewayClientSenderFields(client: GatewayClient | null): {
  sender?: NonNullable<UserTurnInput["sender"]>;
} {
  if (client?.internal?.senderAttribution) {
    return { sender: client.internal.senderAttribution };
  }
  const profile = client?.authenticatedUserProfile;
  if (profile) {
    return {
      sender: {
        id: profile.profileId,
        ...(!client?.internal?.syntheticClient
          ? { identity: { type: "profile" as const, id: profile.profileId } }
          : {}),
        ...(profile.displayName ? { name: profile.displayName } : {}),
      },
    };
  }
  if (client?.authenticatedGitHubIdentitySync) {
    return {};
  }
  return client?.authenticatedUserId ? { sender: { id: client.authenticatedUserId } } : {};
}

/** Returns the same durable human profile identity used for session creation attribution. */
export function gatewayClientSessionCreator(client: GatewayClient | null) {
  const profile = client?.authenticatedUserProfile;
  return profile
    ? {
        type: "human" as const,
        id: profile.profileId,
        ...(profile.displayName ? { label: profile.displayName } : {}),
      }
    : undefined;
}

/** Authenticated ingress facts shared by chat execution and its current caller controls. */
export function resolveChatSendCallerContext(
  client: GatewayClient | null | undefined,
  clientInfo: GatewayClientInfo | undefined = client?.connect?.client,
  originatingChannel: string = INTERNAL_MESSAGE_CHANNEL,
) {
  const synthetic = isSyntheticGatewayCaller(client ?? null);
  const commandSenderAuthority = synthetic
    ? undefined
    : (getCommandSenderAuthority(client) ??
      (() =>
        client?.authenticatedUserId &&
        !client.invalidated &&
        !client.connectionSignal?.aborted &&
        !isSyntheticGatewayCaller(client)
          ? client.authenticatedUserProfile?.profileId
          : undefined));
  return withCommandSenderAuthority(
    {
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      OriginatingChannel: originatingChannel,
      ChatType: "direct",
      ApprovalReviewerDeviceId: normalizeOptionalString(client?.connect?.device?.id),
      ...(!synthetic && !isOperatorUiClient(clientInfo)
        ? {
            SenderId: clientInfo?.id,
            SenderName: clientInfo?.displayName,
            SenderUsername: clientInfo?.displayName,
          }
        : {}),
      GatewayClientScopes: client?.connect?.scopes ?? [],
      GatewayClientCaps: client?.connect?.caps ?? [],
    },
    commandSenderAuthority,
  );
}
