import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import {
  resolveSessionVisibility,
  type SessionSharingTarget,
  type PreparedSessionMutationFacts,
} from "../session-sharing-policy.js";
import {
  captureSessionMutationRouting,
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
  type SessionFactsRead,
} from "../session-sharing-preparation.js";
import { readProjectedSessionMutationTarget } from "../session-sharing-target-read.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import {
  isSameSessionSharingTarget,
  prepareCurrentSessionSharing,
} from "./sessions-sharing-authority.js";
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
  const { client, context, respond } = params;
  const actorId = gatewayClientSessionCreator(client)?.id;
  const runAuthority = client?.internal?.operatorRunAuthority;
  let retained: SessionFactsRead<PreparedSessionMutationFacts> | undefined;
  try {
    const projection = requireSessionRowProjection(context);
    const cfg = context.getRuntimeConfig();
    const assertRouting = captureSessionMutationRouting(cfg);
    const requestedAgent = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
    if (!requestedAgent.ok) {
      deny(requestedAgent.error);
    }
    const targetRef = { sessionKey: params.sessionKey, agentId: requestedAgent.agentId };
    const assertCaller = () => {
      if (
        params.hasCurrentClientAuthority?.() === false ||
        client?.invalidated ||
        client?.connectionSignal?.aborted ||
        gatewayClientSessionCreator(client)?.id !== actorId ||
        getSessionRowProjection(context) !== projection ||
        client?.internal?.operatorRunAuthority !== runAuthority
      ) {
        deny(errorShape(ErrorCodes.FORBIDDEN, "reaction author or session authority changed"));
      }
    };
    assertCaller();
    while (projection.needsMembershipPreparation()) {
      await projection.prepareMembership();
      assertCaller();
    }
    assertRouting(context.getRuntimeConfig());
    const projected = readProjectedSessionMutationTarget(targetRef, cfg, projection);
    if (projected.status === "pending") {
      throw new SessionMutationFactsUnavailableError();
    }
    if (projected.status === "unavailable") {
      retained = await prepareSessionMutationFacts({ cfg, ...targetRef, allowMissing: true });
    }
    const readCurrent = (selected?: SessionSharingTarget) => {
      assertCaller();
      let membership: ReadonlySet<string> | undefined;
      const { currentCfg, policyConfig, sharing } = prepareCurrentSessionSharing({
        client,
        context,
        projection,
        actorId,
        runAuthority,
        isMember: (target, identityId) =>
          retained
            ? membership!.has(identityId)
            : projection.hasMembership(target.storePath, target.storeKey, identityId),
      });
      assertRouting(currentCfg);
      let target: SessionSharingTarget | null;
      if (retained) {
        const facts = retained.readCurrent(currentCfg);
        target = facts.target;
        membership = facts.membership;
      } else {
        const current = readProjectedSessionMutationTarget(targetRef, currentCfg, projection);
        if (current.status !== "ready") {
          throw new SessionMutationFactsUnavailableError();
        }
        target = current.target;
      }
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
  } finally {
    retained?.release();
  }
}
