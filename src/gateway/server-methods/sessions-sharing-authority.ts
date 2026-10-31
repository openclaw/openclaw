import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { operatorSessionCap, resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import { canManageSessionSharing, type SessionSharingTarget } from "../session-sharing-policy.js";
import { SessionMutationFactsUnavailableError } from "../session-sharing-preparation.js";
import { prepareProjectedSessionSharing } from "../session-sharing-read.js";
import {
  isSameSessionSharingTarget,
  prepareSessionSharingRead,
} from "../session-sharing-target-read.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Bind the caller and sharing facts once; each consumer applies its own operation policy. */
export async function prepareSessionSharingAccess(
  params: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "respond" | "signal" | "hasCurrentClientAuthority"
  > & {
    sessionKey: string;
    agentId?: string;
    prepareMembership?: boolean;
  },
  callerChanged: () => never,
) {
  const { client, context, respond } = params;
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return null;
  }
  const projection = requireSessionRowProjection(context);
  const targetRef = { sessionKey: params.sessionKey, agentId: requestedAgent.agentId };
  const actorId = gatewayClientSessionCreator(client)?.id;
  const runAuthority = client?.internal?.operatorRunAuthority;
  const assertCaller = () => {
    params.signal?.throwIfAborted();
    if (
      params.hasCurrentClientAuthority?.() === false ||
      client?.invalidated ||
      client?.connectionSignal?.aborted ||
      gatewayClientSessionCreator(client)?.id !== actorId ||
      getSessionRowProjection(context) !== projection ||
      client?.internal?.operatorRunAuthority !== runAuthority
    ) {
      callerChanged();
    }
  };
  assertCaller();
  if (params.prepareMembership) {
    while (projection.needsMembershipPreparation()) {
      await projection.prepareMembership();
      assertCaller();
    }
  }
  const facts = await prepareSessionSharingRead({ cfg, ...targetRef, projection });
  return {
    projection,
    query: { key: targetRef.sessionKey, agentId: targetRef.agentId },
    storageTarget: facts.storageTarget,
    readCurrent() {
      assertCaller();
      const currentCfg = context.getRuntimeConfig();
      const policyConfig = context.getCommittedRuntimeConfig?.() ?? currentCfg;
      const sharing = prepareProjectedSessionSharing({
        cfg: policyConfig,
        client,
        isMember: (_target, identityId) => current.membership.has(identityId),
      });
      // Synthetic profile and role preparation may invoke authority callbacks.
      const preparedProfile = client?.preparedSessionProfile;
      if (runAuthority) {
        const actor = resolveGatewayOperatorRoleActor(client);
        if (
          actor?.kind !== "operator" ||
          actor.profileId !== runAuthority.profileId ||
          operatorSessionCap(client, policyConfig) !== sharing.sessionCap
        ) {
          throw new SessionMutationFactsUnavailableError();
        }
      }
      const actor = resolveGatewayOperatorRoleActor(client);
      if (
        (runAuthority &&
          (actor?.kind !== "operator" || actor.profileId !== runAuthority.profileId)) ||
        client?.invalidated ||
        client?.connectionSignal?.aborted ||
        gatewayClientSessionCreator(client)?.id !== actorId ||
        getSessionRowProjection(context) !== projection ||
        client?.internal?.operatorRunAuthority !== runAuthority ||
        client?.preparedSessionProfile !== preparedProfile ||
        context.getRuntimeConfig() !== currentCfg ||
        (context.getCommittedRuntimeConfig?.() ?? currentCfg) !== policyConfig
      ) {
        throw new SessionMutationFactsUnavailableError();
      }
      const current = facts.readCurrent(currentCfg);
      return { ...current, sharing, policyConfig };
    },
    [Symbol.dispose]: facts.release,
  };
}

/** Retain one facts owner through management reads, writer grants, and publication. */
export async function prepareManagedSessionAccess(
  params: Pick<
    GatewayRequestHandlerOptions,
    | "client"
    | "context"
    | "respond"
    | "signal"
    | "hasCurrentClientAuthority"
    | "sessionMutationAuthorization"
  > & {
    sessionKey: string;
    agentId?: string;
    operation?: "read" | "mutation";
  },
) {
  const { respond } = params;
  const operation = params.operation ?? "mutation";
  const access = await prepareSessionSharingAccess(params, () => {
    throw new Error(`session ownership changed before sharing ${operation}`);
  });
  if (!access) {
    return null;
  }
  try {
    const readCurrent = (selected?: SessionSharingTarget) => {
      const { target, sharing, sourcePath, sourceAgentId } = access.readCurrent();
      if (selected && !isSameSessionSharingTarget(target, selected)) {
        throw new Error(`session changed before sharing ${operation}`);
      }
      return { target, sharing, sourcePath, sourceAgentId };
    };
    const initial = readCurrent();
    const selected = initial.target;
    if (!selected || !canManageSessionSharing(initial.sharing.roleForTarget(selected))) {
      respond(
        false,
        undefined,
        !selected
          ? errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${params.sessionKey}`)
          : errorShape(ErrorCodes.INVALID_REQUEST, "session owner or operator.admin required", {
              details: {
                code: "SESSION_SHARING_MANAGER_REQUIRED",
                sessionKey: selected.canonicalKey,
              },
            }),
      );
      access[Symbol.dispose]();
      return null;
    }
    const requireManageable = (
      { target, sharing }: ReturnType<typeof readCurrent>,
      entry?: SessionSharingTarget["entry"],
    ) => {
      if (
        entry &&
        (entry.sessionId !== selected.entry.sessionId ||
          entry.lifecycleRevision !== selected.entry.lifecycleRevision)
      ) {
        throw new Error(`session changed before sharing ${operation}`);
      }
      const role = target && sharing.roleForTarget(entry ? { ...target, entry } : target);
      if (!target || !role || !canManageSessionSharing(role)) {
        throw new Error(`session ownership changed before sharing ${operation}`);
      }
      return { target, role };
    };
    const prepareCurrent = (
      assertRequest = () => params.sessionMutationAuthorization?.assertCurrent(),
    ) => {
      assertRequest();
      return readCurrent(selected);
    };
    const current = (entry?: SessionSharingTarget["entry"], assertRequest?: () => void) =>
      requireManageable(prepareCurrent(assertRequest), entry);
    return {
      target: selected,
      // Lifecycle peers still fence the logical locator; worker I/O retains the physical source.
      lifecycleStorePath: access.storageTarget.storePath,
      current,
      assertCurrent: composeSessionSourceAssertion(
        [params.sessionMutationAuthorization?.assertCurrent],
        (assertSources) => {
          current(undefined, assertSources);
        },
      ),
      assertEntryManageable: (entry: SessionSharingTarget["entry"]) => {
        current(entry);
      },
      [Symbol.dispose]: access[Symbol.dispose],
    };
  } catch (error) {
    access[Symbol.dispose]();
    throw error;
  }
}

export function sharingExpectedEntry(target: SessionSharingTarget) {
  return {
    sessionId: target.entry.sessionId,
    createdActor: target.entry.createdActor,
    visibility: target.entry.visibility,
    incognito: target.entry.incognito,
  };
}
