import { isDeepStrictEqual } from "node:util";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target-paths.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
} from "../../config/sessions/session-store-read-candidates.js";
import { isConfiguredSessionStoreAgentId } from "../../config/sessions/targets-configured-agents.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { operatorSessionCap, resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import type {
  PreparedSessionMutationFacts,
  SessionSharingTarget,
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

/** Keep discovery bound to current sharing facts and the session's selected skill revisions. */
export async function withSessionDiscoveryAccess(
  params: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "respond" | "signal" | "hasCurrentClientAuthority"
  > & { sessionKey?: string; agentId: string; changedError: ErrorShape },
  discover: (entry?: SessionEntry) => Promise<unknown>,
): Promise<void> {
  if (!params.sessionKey) {
    params.respond(true, await discover(), undefined);
    return;
  }
  const { client, context, respond } = params;
  const cfg = context.getRuntimeConfig();
  const assertRouting = captureSessionMutationRouting(cfg);
  const requestedAgent = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return;
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
      throw new Error("Session discovery authority changed.");
    }
  };
  let retained: SessionFactsRead<PreparedSessionMutationFacts> | undefined;
  let retainedSourcePath: string | undefined;
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
      const prepared = await prepareSessionMutationFacts({ cfg, ...targetRef, allowMissing: true });
      retained = prepared;
      retainedSourcePath = prepared.readCurrent(context.getRuntimeConfig()).sourcePath;
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
        throw new SessionMutationAuthorizationChangedError(params.changedError);
      }
      if (!target) {
        throw new SessionMutationAuthorizationChangedError(
          errorShape(ErrorCodes.INVALID_REQUEST, "Session not found."),
        );
      }
      const denied = sharing.authorizeTarget(target);
      if (denied) {
        throw new SessionMutationAuthorizationChangedError(denied);
      }
      return target;
    };
    const selected = readCurrent(captured);
    const readEntry = <T>(consume: (entry: SessionEntry) => T) =>
      withReadySessionRows(
        projection,
        () => [query],
        (read) => {
          readCurrent(selected);
          const row = read.describe(query);
          const entry = row?.storedEntry;
          if (
            !entry ||
            (read.readSource(row)?.path ?? row.storeTarget.storePath) !==
              (retainedSourcePath ?? selected.storePath) ||
            entry.sessionId !== selected.entry.sessionId ||
            entry.lifecycleRevision !== selected.entry.lifecycleRevision
          ) {
            throw new SessionMutationAuthorizationChangedError(params.changedError);
          }
          return consume(entry);
        },
      );
    const entry = await readEntry((current) => structuredClone(current));
    readCurrent(selected);
    const result = await discover(entry);
    // Refuse unresolved membership before row preparation can refresh it.
    readCurrent(selected);
    await readEntry((current) => {
      if (!isDeepStrictEqual(current.skillLibrarySelections, entry.skillLibrarySelections)) {
        throw new SessionMutationAuthorizationChangedError(params.changedError);
      }
      respond(true, result, undefined);
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
