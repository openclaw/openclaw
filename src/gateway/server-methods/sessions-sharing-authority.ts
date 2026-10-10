import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
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
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

/** Synthetic profile preparation may reenter authority owners; retain only one current policy. */
export function prepareCurrentSessionSharing(
  params: Pick<GatewayRequestHandlerOptions, "client" | "context"> & {
    projection: ReturnType<typeof requireSessionRowProjection>;
    actorId: string | undefined;
    runAuthority: NonNullable<GatewayClient["internal"]>["operatorRunAuthority"];
    isMember: Parameters<typeof prepareProjectedSessionSharing>[0]["isMember"];
  },
) {
  const { client, context, projection, actorId, runAuthority, isMember } = params;
  const currentCfg = context.getRuntimeConfig();
  const policyConfig = context.getCommittedRuntimeConfig?.() ?? currentCfg;
  const sharing = prepareProjectedSessionSharing({ cfg: policyConfig, client, isMember });
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
    (runAuthority && (actor?.kind !== "operator" || actor.profileId !== runAuthority.profileId)) ||
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
  return { currentCfg, policyConfig, sharing };
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
  const operation = params.operation ?? "mutation";
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
      throw new Error(`session ownership changed before sharing ${operation}`);
    }
  };
  let facts: Awaited<ReturnType<typeof prepareSessionSharingRead>> | undefined;
  try {
    assertCaller();
    facts = await prepareSessionSharingRead({ cfg, ...targetRef, projection });
    const readCurrent = (selected?: SessionSharingTarget) => {
      assertCaller();
      const { currentCfg, sharing } = prepareCurrentSessionSharing({
        client,
        context,
        projection,
        actorId,
        runAuthority,
        isMember: (_target, identityId) => membership.has(identityId),
      });
      const { target, membership } = facts!.readCurrent(currentCfg);
      if (selected && !isSameSessionSharingTarget(target, selected)) {
        throw new Error(`session changed before sharing ${operation}`);
      }
      return { target, sharing };
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
      facts?.release();
      return null;
    }
    const current = (entry?: SessionSharingTarget["entry"]) => {
      // Refuse dirty membership before invoking any additional request authority guard.
      readCurrent(selected);
      params.sessionMutationAuthorization?.assertCurrent();
      const { target, sharing } = readCurrent(selected);
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
    return {
      target: selected,
      // Lifecycle peers still fence the logical locator; worker I/O retains the physical source.
      lifecycleStorePath: facts.storageTarget.storePath,
      current,
      assertCurrent: () => {
        current();
      },
      assertEntryManageable: (entry: SessionSharingTarget["entry"]) => {
        current(entry);
      },
      [Symbol.dispose]: () => facts?.release(),
    };
  } catch (error) {
    facts?.release();
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
