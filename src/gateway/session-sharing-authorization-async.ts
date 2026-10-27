import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import {
  retainPreparedSessionSharingFacts,
  projectSessionSharingEntry,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { SessionCanonicalKeyMigrationRequiredError } from "../config/sessions/session-canonical-key-error.js";
import { releaseSessionSourceAuthorities } from "../config/sessions/session-source-authority.js";
import { sameSessionTranscriptStorePath } from "../config/sessions/transcript-store-identity.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { resolveMissingOperatorScope } from "../shared/operator-scope-compat.js";
import { resolveDatabasePath } from "../state/openclaw-state-db.paths.js";
import {
  prepareUserProfileIdentity,
  readResidentGatewayOwnerProfile,
} from "../state/user-profile-list.js";
import { errorShapeFromError } from "./error-shape.js";
import { resolveGatewayOperatorAccessAuthority } from "./operator-access-policy.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/shared-types.js";
import { sessionMethodDatabaseAdmission, isSessionTargetMethod } from "./session-method-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import {
  prepareSessionMutationAuthorizationRequest,
  sessionMutationTargetChanged,
  type SessionMutationAuthorizationParams,
} from "./session-sharing-authorization.js";
import { authorizePreparedSessionMutation } from "./session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-preparation.js";
import { prepareSessionSharingProfiles } from "./session-sharing-read.js";
import {
  resolveDirectSessionTargets,
  resolveSessionMutationTargets,
  resolveTalkSessionTargetInput,
} from "./session-sharing-target-input.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import { prepareTalkSessionTarget } from "./talk/session-target.js";

/** Admit a new input as a recorded person using only that person's current grants. */
export async function prepareSessionPrincipalRunAuthority(
  params: Parameters<typeof prepareSessionPrincipalRunAccess>[0] & {
    context: Pick<
      GatewayRequestContext,
      "getRuntimeConfig" | "getCommittedRuntimeConfig" | "resolveGatewayContext"
    >;
  },
): Promise<{ authority: AdmittedRunOperatorAuthority; release: () => void }> {
  const source = await prepareSessionPrincipalRunAccess(params);
  try {
    const admitted = await captureGatewayOperatorRunAuthority({
      client: source.client,
      context: params.context,
      sourceAuthority: source,
    });
    if (!admitted) {
      throw new Error("Session principal has no current run authority.");
    }
    return admitted;
  } catch (error) {
    source.release();
    throw error;
  }
}

/** Resolve a recorded person against current grants and an existing exact session. */
async function prepareSessionPrincipalRunAccess(params: {
  context: Pick<GatewayRequestContext, "getRuntimeConfig" | "getCommittedRuntimeConfig">;
  profileId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  storePath?: string;
  assertCurrent?: () => void;
}) {
  params.assertCurrent?.();
  const getConfig = params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig;
  const identity = await prepareUserProfileIdentity(params.profileId);
  const ownerProfilePath = resolveDatabasePath();
  let sharing: Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined;
  const release = () => {
    sharing?.release();
    identity.release();
  };
  const readRole = () => {
    const profile = identity.readCurrentProfile();
    return resolveOperatorRolePolicyForAssignment(
      params.profileId,
      profile.assignedRole,
      getConfig(),
      profile.githubLogin ?? null,
    );
  };
  const readScopes = () => {
    identity.readCurrentProfile();
    // The recorded principal must itself remain the Gateway owner; this is never a fallback.
    if (params.profileId === GATEWAY_OWNER_PROFILE_ID) {
      if (readResidentGatewayOwnerProfile(ownerProfilePath)?.id !== params.profileId) {
        throw new Error("Session principal is no longer the Gateway owner.");
      }
      return ["operator.admin"];
    }
    const scopes = readRole()?.scopes;
    if (!scopes || resolveMissingOperatorScope(["operator.sessions.write"], scopes) !== null) {
      throw new Error("Session principal has no current run authority.");
    }
    return scopes;
  };
  try {
    const scopes = readScopes();
    const access = resolveGatewayOperatorAccessAuthority(params.profileId, getConfig(), {
      requireLivePolicySet: true,
    });
    const preparedSharing = await prepareSessionMutationFacts({
      cfg: getConfig(),
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      followTranscript: true,
    });
    sharing = preparedSharing;
    const initialTarget = preparedSharing.readCurrent(getConfig()).target;
    if (initialTarget.entry.sessionId !== params.sessionId) {
      throw new Error("Session is unavailable for this principal.");
    }
    // A policy adapter identifies the resolved person without manufacturing a transport grant.
    const client: GatewayClient = {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "gateway-client", version: "internal", platform: "node", mode: "backend" },
        role: "operator",
        scopes: [...scopes],
      },
      internal: {
        syntheticClient: true,
        operatorRoleActor: { kind: "operator", profileId: params.profileId },
      },
    };
    const assertCurrent = () => {
      params.assertCurrent?.();
      access?.signal.throwIfAborted();
      access?.assertCurrent();
      const current = identity.readCurrentFacts();
      const currentRole = readRole();
      if (resolveMissingOperatorScope(client.connect.scopes ?? [], readScopes()) !== null) {
        throw new Error("Session principal has no current run authority.");
      }
      const facts = preparedSharing.readCurrent(getConfig());
      const target = facts.target;
      if (
        !target ||
        target.agentId !== params.agentId ||
        target.entry.lifecycleRevision !== initialTarget.entry.lifecycleRevision ||
        target.entry.archivedAt !== undefined ||
        (params.storePath !== undefined &&
          target.storePath !== params.storePath &&
          !sameSessionTranscriptStorePath(params.storePath, facts.readSource?.path))
      ) {
        throw new Error("Session is unavailable for this principal.");
      }
      const error = authorizePreparedSessionMutation(
        { cfg: getConfig(), client, agentId: params.agentId, sessionKey: params.sessionKey },
        facts,
        { policy: currentRole, aliases: current.aliases },
      );
      if (error) {
        throw new Error(error.message);
      }
    };
    assertCurrent();
    return {
      client,
      assertCurrent,
      signal: access?.signal,
      gatewayAccessGrant: access ? access.gatewayAccessGrant : null,
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Read participation in the worker while retaining its owner through authorization. */
export async function resolveSessionMutationAuthorizationAsync(
  request: Parameters<typeof resolveSessionMutationAuthorization>[0] & {
    assertInvocationCurrent?: () => void;
  },
): Promise<ReturnType<typeof resolveSessionMutationAuthorization>> {
  request.assertInvocationCurrent?.();
  const requestPreparation = prepareSessionMutationAuthorizationRequest(request);
  if (!requestPreparation.ok) {
    return { error: requestPreparation.error };
  }
  if (!requestPreparation.requiresSessionFacts) {
    return { error: null };
  }
  let params = { ...request, ...requestPreparation.params };
  const talk = resolveTalkSessionTargetInput(
    params.method,
    params.requestParams,
    params.client?.connId,
  );
  if (talk && !params.preparedTalkSessionTarget) {
    try {
      params = {
        ...params,
        preparedTalkSessionTarget:
          talk.kind === "relay"
            ? talk.target
            : await prepareTalkSessionTarget(params.context.getRuntimeConfig(), talk.sessionKey),
      };
    } catch (error) {
      return {
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          String(error instanceof Error ? error.message : error),
        ),
      };
    }
    params.assertInvocationCurrent?.();
  }
  const targets = params.preparedTalkSessionTarget
    ? [
        {
          sessionKey: params.preparedTalkSessionTarget.canonicalKey,
          agentId: params.preparedTalkSessionTarget.agentId,
        },
      ]
    : [
        ...resolveDirectSessionTargets(params.method, params.requestParams),
        ...(resolveSessionMutationTargets(params) ?? []),
      ];
  if (targets.length === 0 && !params.sessionScope && !isSessionTargetMethod(params.method)) {
    return resolveSessionMutationAuthorization(params);
  }
  const cfg = params.context.getRuntimeConfig();
  const preparedProfiles = await prepareSessionSharingProfiles(params.client);
  const reads: Array<{ release: () => void }> = [];
  const creationReleases: Array<() => void> = [];
  let active = true;
  let transferred = false;
  const release = () => {
    active = false;
    for (const read of reads.splice(0)) {
      read.release();
    }
    for (const stop of creationReleases.splice(0)) {
      stop();
    }
  };
  let references = 0;
  const retain = () => {
    if (!active) {
      throw new Error("Session authorization has been released");
    }
    references += 1;
    let retained = true;
    return () => {
      if (!retained) {
        return;
      }
      retained = false;
      references -= 1;
      if (references === 0) {
        release();
      }
    };
  };
  const releaseRequest = retain();
  try {
    const uniqueTargets = targets.filter(
      (target, index) =>
        targets.findIndex(
          (candidate) =>
            candidate.sessionKey === target.sessionKey && candidate.agentId === target.agentId,
        ) === index,
    );
    const preparedTargets: (NonNullable<
      SessionMutationAuthorizationParams["preparedTargets"]
    >[number] & {
      storageTarget: import("./session-sharing-read.js").PreparedMutationSharing["storageTarget"];
    })[] = [];
    for (const target of uniqueTargets) {
      const input = resolveRequestedSessionAgentId(
        cfg,
        target.sessionKey,
        target.agentId,
        params.databaseAdmission ?? sessionMethodDatabaseAdmission(params.method),
      );
      if (!input.ok) {
        release();
        return { error: input.error };
      }
      const retained = await prepareSessionMutationFacts({
        cfg,
        sessionKey: target.sessionKey,
        agentId: input.agentId,
        allowMissing: true,
        followLifecycle: params.method === "chat.send",
        followTranscript: params.method === "chat.send",
      });
      reads.push(retained);
      const initialFacts = retained.readCurrent(cfg);
      const readCurrent = () => {
        try {
          return retained.readCurrent(params.context.getRuntimeConfig());
        } catch (error) {
          if (error instanceof SessionMutationFactsUnavailableError) {
            throw sessionMutationTargetChanged(params.method, target.sessionKey);
          }
          throw error;
        }
      };
      const readSource = initialFacts.readSource;
      preparedTargets.push({
        ...target,
        storageTarget: retained.storageTarget,
        readSource,
        bindCreation: retained.bindCreation,
        followRegistration: retained.followRegistration,
        prepareRead: retained.prepareRead,
        read: () => {
          const facts = readCurrent();
          return {
            target: facts.target && { ...facts.target, readSource },
            storageTarget: retained.storageTarget,
            members: [],
            isMember: (identityId: string) => facts.membership.has(identityId),
            assertCurrent: () => {
              readCurrent();
            },
          };
        },
      });
    }
    const authorize = (
      sessionRowRead: SessionMutationAuthorizationParams["sessionRowRead"] = params.sessionRowRead,
    ) => {
      params.assertInvocationCurrent?.();
      return resolveSessionMutationAuthorization({
        ...params,
        preparedProfiles,
        preparedTargets,
        sessionRowRead,
      });
    };
    const projection =
      params.method === "sessions.describe" ? getSessionRowProjection(params.context) : undefined;
    const result = projection
      ? await withReadySessionRows(
          projection,
          (currentCfg) =>
            uniqueTargets.flatMap((target) => {
              const agent = resolveRequestedSessionAgentId(
                currentCfg,
                target.sessionKey,
                target.agentId,
                "read",
              );
              return agent.ok ? [{ key: target.sessionKey, agentId: agent.agentId }] : [];
            }),
          authorize,
        )
      : authorize();
    if (!result.authorization) {
      release();
      return result;
    }
    const authorization = result.authorization;
    const prepareWorkerGrant = authorization.prepareWorkerGrant;
    if (prepareWorkerGrant) {
      authorization.prepareWorkerGrant = async (source) => {
        const releaseAuthorization = retain();
        try {
          const grant = await prepareWorkerGrant(source);
          return {
            ...grant,
            release: () =>
              releaseSessionSourceAuthorities([{ release: releaseAuthorization }, grant]),
          };
        } catch (error) {
          await releaseSessionSourceAuthorities([{ release: releaseAuthorization }], [error]);
          throw error;
        }
      };
    }
    return {
      ...result,
      authorization: {
        ...authorization,
        followRegistration: (_target, change) => {
          // The parent's retained discovery also follows its own child-store registration.
          for (const prepared of preparedTargets) {
            prepared.followRegistration?.(change);
          }
        },
        retain,
        release: () => {
          if (!transferred) {
            releaseRequest();
          }
        },
        takeRelease: () => {
          transferred = true;
          return releaseRequest;
        },
        recordCreatedSession: (created) => {
          authorization.recordCreatedSession?.(created);
          if (!created.entry) {
            return;
          }
          const path = created.readSource?.path ?? created.storePath;
          const identity = readDatabasePathIdentitySync(path);
          const retained = retainPreparedSessionSharingFacts({
            databaseIdentity: identity.key,
            sessionKey: created.sessionKey,
            followLifecycle: params.method === "chat.send",
            followTranscript: params.method === "chat.send",
            entry: projectSessionSharingEntry(created.entry),
            membership: new Set(),
          });
          creationReleases.push(retained.release);
          const read = () => {
            const current = retained.readCurrent();
            if (!active || !current?.entry) {
              throw sessionMutationTargetChanged(params.method, created.sessionKey);
            }
            return {
              target: {
                agentId: created.agentId,
                canonicalKey: created.sessionKey,
                storeKey: created.sessionKey,
                storeKeys: [created.sessionKey],
                storePath: created.storePath,
                readSource: created.readSource,
                entry: current.entry,
              },
              storageTarget: {
                agentId: created.agentId,
                canonicalKey: created.sessionKey,
                storePath: created.storePath,
              },
              members: [],
              isMember: (identityId: string) => current.membership.has(identityId),
              assertCurrent: () => {
                if (!active || !retained.readCurrent()) {
                  throw sessionMutationTargetChanged(params.method, created.sessionKey);
                }
              },
            };
          };
          const selected = preparedTargets.find(
            (target) =>
              target.storageTarget.canonicalKey === created.sessionKey &&
              target.storageTarget.agentId === created.agentId,
          );
          if (selected) {
            selected.prepareRead = retained.prepareRead;
            selected.read = read;
            selected.readSource = created.readSource ?? selected.readSource;
          } else {
            preparedTargets.push({
              sessionKey: created.sessionKey,
              agentId: created.agentId,
              storageTarget: {
                agentId: created.agentId,
                canonicalKey: created.sessionKey,
                storePath: created.storePath,
              },
              readSource: created.readSource,
              prepareRead: retained.prepareRead,
              read,
              bindCreation: () => {},
            });
          }
        },
      },
    };
  } catch (error) {
    release();
    if (
      !talk &&
      !(error instanceof AgentSelectionRequiredError) &&
      !(error instanceof SessionCanonicalKeyMigrationRequiredError)
    ) {
      throw error;
    }
    return {
      error:
        error instanceof SessionMutationAuthorizationChangedError
          ? error.error
          : errorShapeFromError(ErrorCodes.INVALID_REQUEST, error),
    };
  }
}
