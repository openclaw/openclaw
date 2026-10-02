import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target-paths.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
} from "../../config/sessions/session-store-read-candidates.js";
import { isConfiguredSessionStoreAgentId } from "../../config/sessions/targets-configured-agents.js";
import { operatorSessionCap, resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import {
  canManageSessionSharing,
  type PreparedSessionMutationFacts,
  type SessionSharingTarget,
} from "../session-sharing-policy.js";
import {
  captureSessionMutationRouting,
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
  type SessionFactsRead,
} from "../session-sharing-preparation.js";
import { prepareProjectedSessionSharing } from "../session-sharing-read.js";
import { readProjectedSessionMutationTarget } from "../session-sharing-target-read.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

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
  const assertRouting = captureSessionMutationRouting(cfg);
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
  let retained: SessionFactsRead<PreparedSessionMutationFacts> | undefined;
  try {
    assertCaller();
    const query = { key: targetRef.sessionKey, agentId: targetRef.agentId };
    const resident = projection.sharingTarget(query);
    const source = resident && projection.readSource({ ...query, storePath: resident.storePath });
    const configuredStorePath = resolveSessionStorePathCore(cfg.session?.store, {
      agentId: requestedAgent.agentId,
    });
    const configuredSource = captureSessionStoreReadCandidate(
      resolveUnsuffixedSqliteTargetFromSessionStorePath(configuredStorePath).path,
    );
    // Readiness may yield across a reset or store replacement. Capture the locator first;
    // membership is not authority until the same projection reports it ready below.
    const captured =
      resident &&
      source?.path === resident.storePath &&
      typeof source.databaseIdentity === "string" &&
      isConfiguredSessionStoreAgentId(cfg, resident.agentId) &&
      source.path === configuredSource.physicalPath
        ? { ...resident, readSource: source }
        : undefined;
    if (!captured) {
      retained = await prepareSessionMutationFacts({ cfg, ...targetRef, allowMissing: true });
    } else {
      while (projection.needsMembershipPreparation()) {
        await projection.prepareMembership();
        assertCaller();
      }
    }
    const readCurrent = (selected?: SessionSharingTarget) => {
      assertCaller();
      const currentCfg = context.getRuntimeConfig();
      const policyConfig = context.getCommittedRuntimeConfig?.() ?? currentCfg;
      let membership: ReadonlySet<string> | undefined;
      // Synthetic preparation may invoke authority callbacks; read session facts afterward.
      const sharing = prepareProjectedSessionSharing({
        cfg: policyConfig,
        client,
        isMember: (target, identityId) =>
          retained
            ? membership!.has(identityId)
            : projection.hasMembership(target.storePath, target.storeKey, identityId),
      });
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
      assertRouting(currentCfg);
      let target: SessionSharingTarget | null;
      if (retained) {
        const facts = retained.readCurrent(currentCfg);
        target = facts.target;
        membership = facts.membership;
      } else {
        assertSessionStoreReadCandidate(configuredSource.path, [configuredSource]);
        const current = readProjectedSessionMutationTarget(targetRef, currentCfg, projection);
        if (current.status !== "ready") {
          throw new SessionMutationFactsUnavailableError();
        }
        target = current.target;
      }
      if (
        selected &&
        (!target ||
          target.agentId !== selected.agentId ||
          target.canonicalKey !== selected.canonicalKey ||
          target.storeKey !== selected.storeKey ||
          target.storePath !== selected.storePath ||
          target.entry.sessionId !== selected.entry.sessionId ||
          target.entry.lifecycleRevision !== selected.entry.lifecycleRevision ||
          target.readSource?.path !== selected.readSource?.path ||
          target.readSource?.agentId !== selected.readSource?.agentId ||
          target.readSource?.databaseIdentity !== selected.readSource?.databaseIdentity ||
          target.readSource?.databaseBirthtime !== selected.readSource?.databaseBirthtime)
      ) {
        throw new Error(`session changed before sharing ${operation}`);
      }
      return { target, sharing };
    };
    const initial = readCurrent(captured);
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
      retained?.release();
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
      lifecycleStorePath: retained?.storageTarget.storePath ?? configuredStorePath,
      current,
      assertCurrent: () => {
        current();
      },
      assertEntryManageable: (entry: SessionSharingTarget["entry"]) => {
        current(entry);
      },
      [Symbol.dispose]: () => retained?.release(),
    };
  } catch (error) {
    retained?.release();
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
