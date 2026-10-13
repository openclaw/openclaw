import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveSessionVisibility, type SessionSharingTarget } from "../session-sharing-policy.js";
import { SessionMutationFactsUnavailableError } from "../session-sharing-preparation.js";
import { isSameSessionSharingTarget } from "../session-sharing-target-read.js";
import { prepareSessionSharingAccess } from "./sessions-sharing-authority.js";
import { requireVisibleSuggestionRole } from "./sessions-suggestions-access.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function deny(error: ErrorShape): never {
  throw new SessionMutationAuthorizationChangedError(error);
}

/** Retain the selected facts owner through reads, commit grants, and mirror settlement. */
export async function withSessionReactionAccess(
  params: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "respond" | "hasCurrentClientAuthority"
  > & {
    sessionKey: string;
    agentId?: string;
    write: boolean;
  },
  consume: (access: { target: SessionSharingTarget; assertCurrent: () => void }) => Promise<void>,
): Promise<void> {
  const { client, respond } = params;
  try {
    using access = await prepareSessionSharingAccess({ ...params, prepareMembership: true }, () =>
      deny(errorShape(ErrorCodes.FORBIDDEN, "reaction author or session authority changed")),
    );
    if (!access) {
      return;
    }
    const readCurrent = (selected?: SessionSharingTarget) => {
      const { target, policyConfig, sharing } = access.readCurrent();
      if (selected && !isSameSessionSharingTarget(target, selected)) {
        throw new SessionMutationFactsUnavailableError();
      }
      if (
        !target ||
        (hasOperatorBoundary(client, policyConfig, sharing) &&
          sharing.entryFilter?.(target.storeKey, target.entry) === false)
      ) {
        deny(errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${params.sessionKey}`));
      }
      requireVisibleSuggestionRole({
        cfg: policyConfig,
        client,
        sessionKey: params.sessionKey,
        target,
        sharing,
        respond: (_ok, _payload, error) => {
          if (error) {
            deny(error);
          }
        },
      });
      if (params.write) {
        const role = sharing.roleForTarget(target);
        const cap = sharing.sessionCap;
        if (cap === "none") {
          deny(
            errorShape(
              ErrorCodes.FORBIDDEN,
              "your operator role does not permit session reactions",
            ),
          );
        }
        if (cap === "view" && role === "viewer") {
          deny(
            errorShape(ErrorCodes.FORBIDDEN, "your operator role permits viewing sessions only"),
          );
        }
        const denied = sharing.authorizeTarget(target);
        if (denied && !(resolveSessionVisibility(target.entry) === "suggest" && cap !== "view")) {
          deny(denied);
        }
      }
      return target;
    };
    const selected = readCurrent();
    await consume({
      target: selected,
      assertCurrent: () => {
        readCurrent(selected);
      },
    });
  } catch (error) {
    respond(
      false,
      undefined,
      error instanceof SessionMutationAuthorizationChangedError
        ? error.error
        : errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
    );
  }
}
