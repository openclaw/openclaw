import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import {
  retainPreparedSessionSharingFacts,
  projectSessionSharingEntry,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { SessionCanonicalKeyMigrationRequiredError } from "../config/sessions/session-canonical-key-error.js";
import { releaseSessionSourceAuthorities } from "../config/sessions/session-source-authority.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { errorShapeFromError } from "./error-shape.js";
import { isSessionTargetMethod } from "./session-method-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import {
  prepareSessionMutationAuthorizationRequest,
  sessionMutationTargetChanged,
  type SessionMutationAuthorizationParams,
} from "./session-sharing-authorization.js";
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
      const input = resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId);
      if (!input.ok) {
        release();
        return { error: input.error };
      }
      const retained = await prepareSessionMutationFacts({
        cfg,
        sessionKey: target.sessionKey,
        agentId: input.agentId,
        allowMissing: true,
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
