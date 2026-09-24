import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { USER_PROFILE_ID_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { prepareUserProfileSelectionAuthority } from "../state/user-channel-identity-operations.js";
import { readUserProfileIdentity } from "../state/user-profile-list.js";
import type { GatewayClient, RespondFn } from "./server-methods/types.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

/** Prepare at identity lifecycle boundaries; serialization must never query profile storage. */
export function prepareGatewayRecipientProfile(
  client: GatewayClient & Pick<GatewayWsClient, "connectionKind" | "preparedRecipientProfileId">,
  prepared?: { identity: GatewayWsClient["preparedSessionProfile"] },
): void {
  client.preparedRecipientProfileId = undefined;
  client.preparedSessionProfile = undefined;
  if (client.connectionKind === "worker" || (client.connect.role ?? "operator") !== "operator") {
    return;
  }
  try {
    const attached = client.authenticatedUserProfile?.profileId;
    const profile = prepared
      ? prepared.identity
      : attached
        ? readUserProfileIdentity(attached)
        : undefined;
    if (profile && profile.profileId.length <= USER_PROFILE_ID_MAX_LENGTH) {
      client.preparedSessionProfile = profile;
      client.preparedRecipientProfileId = profile.profileId;
    }
  } catch {
    // Failed acquisition leaves prepared identity unavailable; existing authentication stays intact.
  }
}

export class ExpectedProfileMismatchError extends SessionMutationAuthorizationChangedError {}

/** Request-local selection precondition, independent of socket and accepted-run lifetime. */
export async function createExpectedProfileBinding(
  expectedProfileId: string | undefined,
  client: GatewayClient | null,
  assertRequestCurrent?: () => void,
) {
  if (expectedProfileId === undefined) {
    return undefined;
  }
  let prepared: Awaited<ReturnType<typeof prepareUserProfileSelectionAuthority>>;
  const authenticatedUserId = client?.authenticatedUserId;
  const synchronizeProfile = client?.authenticatedGitHubIdentitySync;
  let profileReference = client?.authenticatedUserProfile?.profileId;
  try {
    assertRequestCurrent?.();
    if (!profileReference && synchronizeProfile) {
      await synchronizeProfile();
      assertRequestCurrent?.();
      if (
        client?.authenticatedUserId !== authenticatedUserId ||
        client?.authenticatedGitHubIdentitySync !== synchronizeProfile
      ) {
        throw new Error("Gateway requester identity changed");
      }
      profileReference = client?.authenticatedUserProfile?.profileId;
    }
    prepared = profileReference
      ? await prepareUserProfileSelectionAuthority(profileReference)
      : undefined;
    assertRequestCurrent?.();
  } catch {
    // Unavailable canonical identity cannot prove the selected account.
    prepared = undefined;
  }
  let invoked = false;
  const resolvedProfileError = (profileId: string | undefined) => {
    // Only the authenticated side follows merges. A selection must never silently
    // move to another account because its former ID now aliases that account.
    if (profileId === expectedProfileId) {
      return undefined;
    }
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "Selected account changed or is unavailable. Select the account again before retrying.",
      {
        details: {
          reason: "EXPECTED_PROFILE_MISMATCH",
          execution: invoked ? "may_have_executed" : "not_started",
        },
      },
    );
  };
  const currentError = () => {
    let resolvedProfileId: string | undefined;
    try {
      resolvedProfileId =
        client?.authenticatedUserId === authenticatedUserId &&
        client?.authenticatedUserProfile?.profileId === profileReference &&
        prepared?.isCurrent()
          ? prepared.profileId
          : undefined;
    } catch {
      // Canonical selection is unavailable; response delivery retains its own transport owner.
    }
    return resolvedProfileError(resolvedProfileId);
  };
  return {
    assertCurrent: () => {
      assertRequestCurrent?.();
      const error = currentError();
      if (error) {
        throw new ExpectedProfileMismatchError(error);
      }
    },
    /** Compare a profile resolved by the storage owner on its transaction connection. */
    assertMatchesResolvedProfile: (profileId: string | undefined) => {
      const error = resolvedProfileError(profileId);
      if (error) {
        throw new ExpectedProfileMismatchError(error);
      }
    },
    markInvoked: () => {
      invoked = true;
    },
    guardResponse:
      (respond: RespondFn): RespondFn =>
      (...args) => {
        const mismatch = currentError();
        if (mismatch) {
          respond(false, undefined, mismatch);
        } else {
          respond(...args);
        }
      },
  };
}

export type ExpectedProfileBinding = NonNullable<
  Awaited<ReturnType<typeof createExpectedProfileBinding>>
>;
