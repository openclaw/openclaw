import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
// Projects prepared connection identity into user-turn attribution fields.
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
import { INTERNAL_MESSAGE_CHANNEL, isOperatorUiClient } from "../../utils/message-channel.js";
import { isSyntheticGatewayCaller } from "./gateway-personal-caller.js";
import type { GatewayClient } from "./shared-types.js";

export function isGatewayClientProfilePending(client: GatewayClient | null): boolean {
  return Boolean(client?.authenticatedGitHubIdentitySync && !client.authenticatedUserProfile);
}

export function authenticatedProfileUnavailableError(
  message = "Authenticated profile verification is unavailable. Retry shortly; if this continues, contact a gateway administrator.",
  retryAfterMs = 1_000,
): ErrorShape {
  return errorShape(ErrorCodes.UNAVAILABLE, message, {
    retryable: true,
    retryAfterMs,
    details: { code: ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE },
  });
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
