import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  ErrorCodes,
  errorShape,
  type QuestionRecord,
  type QuestionResolvedEvent,
} from "../../packages/gateway-protocol/src/index.js";
import { retainSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { readGatewayAccessRevision } from "./gateway-access-revision.js";
import { hasOperatorBoundary, resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { usesOwnRunQuestionAccess } from "./question-access.js";
import {
  QuestionManagerError,
  QuestionManagerErrorCodes,
  type QuestionObservation,
} from "./question-manager.js";
import type { QuestionSessionAccess } from "./question-session-access.types.js";
import {
  prepareQuestionSharing,
  withPreparedQuestionSessions,
  withPreparedQuestionSessionOwner,
  type PreparedQuestionSession,
  type QuestionTarget,
} from "./question-session-preparation.js";
import { readGatewayRequestMutationAuthority } from "./server-methods/session-mutation-guards.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { authorizeOwnSessionMutation } from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import { canReceiveSessionEvent } from "./session-sharing-read.js";
import { isGatewayAdmin } from "./session-sharing.js";
export {
  withPreparedQuestionSessions,
  type PreparedQuestionSession,
} from "./question-session-preparation.js";

/** Capture before the first worker await, then bind only the exact admitted row in its consumer. */
export async function withQuestionSessionAccess<T>(
  options: GatewayRequestHandlerOptions,
  sessionKey: string,
  agentId: string,
  consume: (
    access: QuestionSessionAccess | undefined,
    prepared: PreparedQuestionSession | undefined,
  ) => T,
  operation: { assertCurrent: () => void; includeMembers?: boolean },
): Promise<T> {
  operation.assertCurrent();
  const producer = resolveGatewayOperatorRoleActor(options.client);
  const source = await captureGatewayOperatorRunAuthority(options);
  const profileId =
    usesOwnRunQuestionAccess(options.client) && options.client?.internal?.operatorRunAuthority
      ? source?.authority.profileId
      : undefined;
  let transferred = false;
  try {
    return await withPreparedQuestionSessions(
      options,
      [{ sessionKey, agentId }],
      ([prepared]) => {
        const selected = prepared?.target;
        if (
          !prepared ||
          !selected?.entry.sessionId ||
          !selected.entry.lifecycleRevision ||
          selected.entry.incognito ||
          isIncognitoSessionKey(selected.canonicalKey)
        ) {
          return consume(undefined, prepared);
        }
        source?.authority.assertCurrent();
        const retained = retainSessionHistoryWorkerDatabase(prepared.read.database);
        const identity = prepared.read.result.databaseIdentity;
        const original = {
          agentId: selected.agentId,
          sessionKey: selected.canonicalKey,
          storePath: selected.storePath,
          databasePath: prepared.read.database.path,
          sessionId: selected.entry.sessionId,
          lifecycleRevision: selected.entry.lifecycleRevision,
        };
        let released = false;
        let invalidated = false;
        const assertSourceCurrent = () => {
          if (released || invalidated) {
            throw new Error("Question session source was released");
          }
          // Discovery may rotate worker connections normally; the retained host
          // resource, not a worker connection UUID, owns close/reopen revocation.
          retained.owner.assertCurrent();
          source?.authority.assertCurrent();
          const currentProducer = resolveGatewayOperatorRoleActor(options.client);
          if (
            producer?.kind === "operator" &&
            (currentProducer?.kind !== "operator" ||
              producer.profileId !== currentProducer.profileId)
          ) {
            throw new Error("Question producer identity changed");
          }
        };
        const access: QuestionSessionAccess = {
          agentId: original.agentId,
          sessionKey: original.sessionKey,
          durableBinding: identity
            ? { ...original, databaseIdentity: identity, ...(profileId ? { profileId } : {}) }
            : undefined,
          canSelect: (client) =>
            Boolean(
              profileId &&
              client &&
              !client.invalidated &&
              (client.connect.role ?? "operator") === "operator" &&
              !authorizeOwnSessionMutation({ client, target: null, expectedProfileId: profileId }),
            ),
          assertSourceCurrent,
          assertCurrent: (current) => {
            assertSourceCurrent();
            current.assertCurrent();
            const next = current.target;
            const nextIdentity = current.read.result.databaseIdentity;
            if (
              !identity ||
              !nextIdentity ||
              identity.identity !== nextIdentity.identity ||
              identity.birthtime !== nextIdentity.birthtime ||
              current.read.database.path !== original.databasePath ||
              next?.agentId !== original.agentId ||
              next.canonicalKey !== original.sessionKey ||
              next.storePath !== original.storePath ||
              next.entry.sessionId !== original.sessionId ||
              next.entry.lifecycleRevision !== original.lifecycleRevision ||
              next.entry.incognito
            ) {
              // A proven successor cannot revive this source. Pending requester checks
              // cancel only this binding; terminal records remain immutable but unreadable.
              invalidated = true;
              throw new Error("Question session generation changed");
            }
          },
          release: () => {
            if (!released) {
              released = true;
              try {
                retained.release();
              } finally {
                source?.release();
              }
            }
          },
        };
        transferred = true;
        try {
          const value = consume(access, prepared);
          if (isPromiseLike(value)) {
            void Promise.resolve(value).catch(() => {});
            throw new Error("Question session consumers must remain synchronous");
          }
          return value;
        } catch (error) {
          access.release();
          throw error;
        }
      },
      {
        assertCurrent: () => {
          operation.assertCurrent();
          source?.authority.assertCurrent();
        },
        includeMembers: operation.includeMembers,
      },
    );
  } finally {
    if (!transferred) {
      source?.release();
    }
  }
}

function canAccessSessionQuestion(
  observation: QuestionObservation | null,
  prepared: PreparedQuestionSession | undefined,
  client: GatewayClient | null,
): boolean {
  try {
    if (
      !observation?.isCurrent() ||
      !observation.ordinary ||
      !observation.sessionAccess?.canSelect(client) ||
      !prepared
    ) {
      return false;
    }
    const allowed = prepared.canAccess(client, true, observation.sessionAccess);
    if (!allowed) {
      // A worker may have just proved the original binding invalid. Settle that
      // exact entry now; neither a transient read failure nor a successor is cancellation.
      observation.refreshRequester();
    }
    return allowed;
  } catch {
    return false;
  }
}

export function questionNotFound(id: string) {
  return errorShape(ErrorCodes.INVALID_REQUEST, `question '${id}' was not found`, {
    details: { reason: QuestionManagerErrorCodes.NOT_FOUND },
  });
}

export function prepareQuestionAuthorization(
  options: GatewayRequestHandlerOptions,
  observation: QuestionObservation | null,
  id: string,
  access: "read" | "mutate",
) {
  const authority = readGatewayRequestMutationAuthority(options);
  const actor = resolveGatewayOperatorRoleActor(options.client);
  const narrow = usesOwnRunQuestionAccess(options.client);
  return {
    target:
      observation?.sessionAccess?.durableCustody ||
      observation?.authorizeClient ||
      narrow ||
      (!isGatewayAdmin(options.client) &&
        hasOperatorBoundary(options.client, options.context.getRuntimeConfig()))
        ? { ...observation?.record, sessionAccess: observation?.sessionAccess }
        : {},
    assertCurrent: () => {
      authority.assertCurrent();
      if (narrow && observation?.sessionAccess) {
        try {
          observation.sessionAccess.assertSourceCurrent();
        } catch {
          observation.refreshRequester();
          throw new QuestionManagerError(
            QuestionManagerErrorCodes.NOT_FOUND,
            `question '${id}' was not found`,
          );
        }
      }
    },
    authorize: (prepared?: PreparedQuestionSession) => {
      if (!observation?.isCurrent()) {
        return questionNotFound(id);
      }
      if (observation.sessionAccess?.durableCustody) {
        try {
          if (!prepared) {
            return questionNotFound(id);
          }
          observation.sessionAccess.assertCurrent(prepared);
        } catch {
          return questionNotFound(id);
        }
      }
      if (observation.authorizeClient) {
        authority.assertCurrent();
        return observation.authorizeClient(options.client, prepared?.target) &&
          (prepared?.canAccess(options.client, false) ||
            (!prepared?.target && isGatewayAdmin(options.client)))
          ? null
          : questionNotFound(id);
      }
      if (narrow) {
        authority.assertCurrent();
        const current = resolveGatewayOperatorRoleActor(options.client);
        if (
          actor?.kind !== "operator" ||
          current?.kind !== "operator" ||
          current.profileId !== actor.profileId ||
          !canAccessSessionQuestion(observation, prepared, options.client)
        ) {
          return questionNotFound(id);
        }
        return null;
      }
      if (
        isGatewayAdmin(options.client) ||
        !hasOperatorBoundary(options.client, options.context.getRuntimeConfig()) ||
        !observation.record.sessionKey
      ) {
        return null;
      }
      if (!prepared?.canAccess(options.client, false)) {
        return questionNotFound(id);
      }
      return access === "mutate" ? prepared.authorizeMutation(options.client) : null;
    },
  };
}

/** Retain the existing sharing facts owner through an asynchronous secret-answer commit. */
export async function prepareQuestionCommitAuthority(
  options: GatewayRequestHandlerOptions,
  observation: QuestionObservation | null,
  id: string,
) {
  const authorization = prepareQuestionAuthorization(options, observation, id, "mutate");
  authorization.assertCurrent();
  const cfg = options.context.getRuntimeConfig();
  const target: QuestionTarget = authorization.target;
  const resolved = target.sessionKey
    ? resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId)
    : undefined;
  if (resolved && !resolved.ok) {
    throw new QuestionManagerError(
      QuestionManagerErrorCodes.NOT_FOUND,
      questionNotFound(id).message,
    );
  }
  const custody = observation?.sessionAccess?.durableCustody
    ? observation.sessionAccess.durableBinding
    : undefined;
  const facts =
    target.sessionKey && resolved?.ok
      ? await prepareSessionMutationFacts({
          cfg,
          sessionKey: target.sessionKey,
          agentId: resolved.agentId,
          allowMissing: true,
          ...(custody
            ? {
                preparedSource: {
                  agentId: custody.agentId,
                  storePath: custody.storePath,
                  canonicalKey: custody.sessionKey,
                  path: custody.databasePath,
                  databaseIdentity: custody.databaseIdentity.identity,
                  databaseBirthtime: custody.databaseIdentity.birthtime,
                  assertCurrent: () => {
                    authorization.assertCurrent();
                    observation?.sessionAccess?.assertSourceCurrent();
                  },
                },
              }
            : {}),
        })
      : undefined;
  let callerCommit:
    | ReturnType<
        NonNullable<
          ReturnType<typeof readGatewayRequestMutationAuthority>["questionCallerRead"]
        >["retainNative"]
      >
    | undefined;
  const assertCurrent = () => {
    authorization.assertCurrent();
    callerCommit?.assertCurrent();
    options.client?.internal?.operatorAccessAuthority?.assertCurrent();
    options.client?.internal?.operatorRunAuthority?.assertCurrent();
    const currentCfg = options.context.getRuntimeConfig();
    const accessRevision = readGatewayAccessRevision();
    let current = facts?.readCurrent(currentCfg);
    const sharing = prepareQuestionSharing(
      currentCfg,
      options.client,
      (_target, identityId) => current?.membership.has(identityId) ?? false,
    );
    // Policy callbacks can revoke the source; reread the owner-held facts afterward.
    authorization.assertCurrent();
    callerCommit?.assertCurrent();
    current = facts?.readCurrent(options.context.getRuntimeConfig());
    const narrow = usesOwnRunQuestionAccess(options.client);
    const binding = observation?.sessionAccess?.durableBinding;
    if (observation?.sessionAccess?.durableCustody && binding) {
      const identity = current?.sourcePath
        ? readDatabasePathIdentitySync(current.sourcePath)
        : undefined;
      const currentTarget = current?.target;
      if (
        !identity ||
        identity.key !== `file:${binding.databaseIdentity.identity}` ||
        identity.birthtime !== binding.databaseIdentity.birthtime ||
        current?.sourcePath !== binding.databasePath ||
        currentTarget?.agentId !== binding.agentId ||
        currentTarget.canonicalKey !== binding.sessionKey ||
        currentTarget.storePath !== binding.storePath ||
        currentTarget.entry.sessionId !== binding.sessionId ||
        currentTarget.entry.lifecycleRevision !== binding.lifecycleRevision ||
        currentTarget.entry.incognito
      ) {
        throw new QuestionManagerError(
          QuestionManagerErrorCodes.NOT_FOUND,
          questionNotFound(id).message,
        );
      }
    }
    const narrowAllowed = Boolean(
      narrow &&
      observation?.ordinary &&
      binding &&
      current?.target &&
      observation.sessionAccess?.canSelect(options.client) &&
      current.target.entry.sessionId === binding.sessionId &&
      current.target.entry.lifecycleRevision === binding.lifecycleRevision &&
      !current.target.entry.incognito &&
      !authorizeOwnSessionMutation({
        client: options.client,
        target: current.target,
        expectedProfileId: binding.profileId,
      }),
    );
    if (
      !observation?.isCurrent() ||
      (narrow && !narrowAllowed) ||
      currentCfg !== options.context.getRuntimeConfig() ||
      (!isGatewayAdmin(options.client) &&
        hasOperatorBoundary(options.client, currentCfg) &&
        observation.record.sessionKey &&
        (!current?.target ||
          sharing.entryFilter?.(current.target.storeKey, current.target.entry) === false ||
          sharing.authorizeTarget(current.target))) ||
      accessRevision !== readGatewayAccessRevision()
    ) {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.NOT_FOUND,
        questionNotFound(id).message,
      );
    }
  };
  try {
    callerCommit = readGatewayRequestMutationAuthority(options).questionCallerRead?.retainNative();
    assertCurrent();
    return {
      assertCurrent,
      release: () => {
        callerCommit?.release();
        facts?.release();
      },
    };
  } catch (error) {
    callerCommit?.release();
    facts?.release();
    throw error;
  }
}

export function questionBroadcastOptions(params: {
  observation: QuestionObservation | null;
  prepared?: PreparedQuestionSession;
  expectedRecord?: QuestionRecord;
  cfg: OpenClawConfig;
  isPublishing: () => boolean;
}) {
  const { observation, prepared, expectedRecord, cfg, isPublishing } = params;
  const sessionKey = observation?.record.sessionKey;
  if (!prepared && !sessionKey) {
    return undefined;
  }
  const isCurrent = () =>
    Boolean(
      isPublishing() &&
      observation?.isCurrent() &&
      (!expectedRecord ||
        (observation.record === expectedRecord && expectedRecord.status === "pending")),
    );
  return {
    questionRecipient: (client: GatewayClient) => {
      if (!isCurrent()) {
        return false;
      }
      if (observation?.authorizeClient && !observation.authorizeClient(client, prepared?.target)) {
        return false;
      }
      if (usesOwnRunQuestionAccess(client) && !observation?.authorizeClient) {
        return canAccessSessionQuestion(observation, prepared, client);
      }
      if (prepared) {
        return prepared.canReceive(client);
      }
      if (observation?.sessionAccess?.durableCustody) {
        return false;
      }
      // Unknown worker facts grant no narrow access. The existing sharing owner
      // still admits admin/system and role-less unidentified recipients without SQL.
      return canReceiveSessionEvent({
        cfg,
        client,
        sessionKeys: sessionKey ? [sessionKey] : [],
        agentId: observation?.record.agentId,
        prepared: {
          sharing: prepareQuestionSharing(cfg, client, () => false),
          target: () => null,
        },
      });
    },
  };
}

/** Server-owned facts prepare recipients; stored custody grants no recipient authority. */
export async function publishDurableQuestionResolution(params: {
  context: GatewayRequestContext;
  event: QuestionResolvedEvent;
  observation: QuestionObservation;
  assertCurrent: () => void;
}): Promise<void> {
  const { context, event, observation } = params;
  const assertCurrent = () => {
    params.assertCurrent();
    if (!observation.isCurrent()) {
      throw new Error("Durable question publication owner changed.");
    }
  };
  await withPreparedQuestionSessionOwner(
    context,
    undefined,
    [{ ...observation.record, sessionAccess: observation.sessionAccess }],
    ([prepared]) => {
      assertCurrent();
      let publishing = true;
      try {
        context.broadcast("question.resolved", event, {
          sessionKeys: observation.record.sessionKey ? [observation.record.sessionKey] : [],
          ...(observation.record.agentId ? { agentId: observation.record.agentId } : {}),
          ...questionBroadcastOptions({
            observation,
            prepared,
            cfg: context.getRuntimeConfig(),
            isPublishing: () => publishing,
          }),
        });
      } finally {
        publishing = false;
      }
    },
    { assertCurrent, includeMembers: true },
  );
}
