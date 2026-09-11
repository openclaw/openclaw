import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { USER_PROFILE_ID_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import type { GatewayClient, RespondFn } from "./server-methods/types.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

/** Prepare at identity lifecycle boundaries; serialization must never query profile storage. */
export function prepareGatewayRecipientProfile(client: GatewayWsClient): void {
  client.preparedRecipientProfileId = undefined;
  if (client.connectionKind === "worker" || (client.connect.role ?? "operator") !== "operator") {
    return;
  }
  try {
    const attached = client.authenticatedUserProfile?.profileId;
    const canonical = attached ? resolveUserProfileId(attached) : undefined;
    if (canonical && canonical.length <= USER_PROFILE_ID_MAX_LENGTH) {
      client.preparedRecipientProfileId = canonical;
    }
  } catch {
    // Leave only the publication stamp unavailable. Existing authentication stays intact.
  }
}

export class ExpectedProfileMismatchError extends SessionMutationAuthorizationChangedError {}

/** Request-local selection precondition, independent of socket and accepted-run lifetime. */
export function createExpectedProfileBinding(
  expectedProfileId: string | undefined,
  client: GatewayClient | null,
) {
  if (expectedProfileId === undefined) {
    return undefined;
  }
  let invoked = false;
  const currentError = () => {
    try {
      const profileId = client?.authenticatedUserProfile?.profileId;
      // Only the authenticated side follows merges. A selection must never silently
      // move to another account because its former ID now aliases that account.
      if (profileId && resolveUserProfileId(profileId) === expectedProfileId) {
        return undefined;
      }
    } catch {
      // Unavailable canonical identity cannot prove the selected account.
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
  return {
    assertCurrent: () => {
      const error = currentError();
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

export type ExpectedProfileBinding = NonNullable<ReturnType<typeof createExpectedProfileBinding>>;
