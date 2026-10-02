import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  ErrorCodes,
  errorShape,
  type QuestionRecord,
} from "../../packages/gateway-protocol/src/index.js";
import {
  withSessionEntriesFromStoresInWorker,
  type PreparedSessionEntryWorkerRead,
} from "../config/sessions/session-entry-read-runtime.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { retainSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { readUserProfileAliases } from "../state/user-profile-list.js";
import { readGatewayAccessRevision } from "./gateway-access-revision.js";
import {
  authorizeCurrentOperatorRoleScopes,
  hasOperatorBoundary,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { usesOwnRunQuestionAccess } from "./question-access.js";
import {
  QuestionManagerError,
  QuestionManagerErrorCodes,
  type QuestionObservation,
} from "./question-manager.js";
import type { QuestionSessionAccess } from "./question-session-access.types.js";
import { readGatewayRequestMutationAuthority } from "./server-methods/session-mutation-guards.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import {
  authorizeOwnSessionMutation,
  sharingIdentity,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { canReceiveSessionEvent } from "./session-sharing-read.js";
import { isGatewayAdmin, prepareSessionSharing } from "./session-sharing.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";

type QuestionTarget = {
  agentId?: string;
  sessionKey?: string;
  sessionAccess?: QuestionSessionAccess;
};

export type PreparedQuestionSession = {
  readonly target: SessionSharingTarget | null;
  readonly read: PreparedSessionEntryWorkerRead;
  assertCurrent: () => void;
  canAccess: (
    client: GatewayClient | null,
    access: "read" | "mutate",
    narrow: boolean,
    binding?: QuestionSessionAccess,
  ) => boolean;
  authorizeMutation: (
    client: GatewayClient | null,
  ) => ReturnType<ReturnType<typeof prepareSessionSharing>["authorizeTarget"]>;
  canReceive: (client: GatewayClient) => boolean;
};

function prepareQuestionSharing(
  cfg: OpenClawConfig,
  client: GatewayClient | null,
  isMember: (target: SessionSharingTarget, identityId: string) => boolean,
) {
  // Hosted callers carry an admitted role actor without a browser profile.
  // Keep sharing identity precedence and role assignment in their existing owners.
  const identity = sharingIdentity(client, resolveGatewayOperatorRoleActor(client));
  return prepareSessionSharing(
    { cfg, client },
    {
      aliases: identity ? readUserProfileAliases(identity.id) : new Set(),
      sessionCap: operatorSessionCap(client, cfg),
      isMember,
    },
  );
}

/** Batch a response's targets; no row or recipient predicate remains authoritative after consume. */
export async function withPreparedQuestionSessions<T>(
  options: GatewayRequestHandlerOptions,
  questions: readonly QuestionTarget[],
  consume: (prepared: readonly (PreparedQuestionSession | undefined)[]) => T,
  operation: { assertCurrent: () => void; includeMembers?: boolean },
): Promise<T> {
  const signal = getAsyncWorkSignal();
  while (true) {
    operation.assertCurrent();
    const cfg = options.context.getRuntimeConfig();
    const accessRevision = readGatewayAccessRevision();
    let changed = false;
    const groups = new Map<
      string,
      {
        agentId: string;
        storePath: string;
        sessionKeys: string[];
        includeMembers: boolean;
        includeAuthorization: true;
      }
    >();
    const selections = questions.map((question) => {
      if (!question.sessionKey) {
        return undefined;
      }
      const resolved = resolveRequestedSessionAgentId(cfg, question.sessionKey, question.agentId);
      if (!resolved.ok) {
        return undefined;
      }
      const agentId = resolved.agentId;
      const sessionKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId,
        sessionKey: question.sessionKey,
      });
      const storePath = resolveSessionStorePathForScope({ agentId, sessionKey }, cfg);
      const key = JSON.stringify([agentId, storePath]);
      const group = groups.get(key) ?? {
        agentId,
        storePath,
        sessionKeys: [],
        includeMembers: operation.includeMembers ?? false,
        includeAuthorization: true as const,
      };
      group.sessionKeys.push(sessionKey);
      groups.set(key, group);
      return { key, agentId, sessionKey, storePath, binding: question.sessionAccess };
    });
    // An empty batch completes locally after a waiter closes. Actual reads still
    // belong to the work scope; request authority is checked for both paths.
    const readSignal = groups.size > 0 ? signal : undefined;
    readSignal?.throwIfAborted();
    const keys = [...groups.keys()];
    // Reuse committed row publications without materializing the listing projection.
    // Unrelated session traffic must never restart this exact-target read.
    const unsubscribe = sessionChanges.subscribe((change) => {
      if ("all" in change) {
        const scope = change.scope;
        changed ||=
          typeof scope === "string" ||
          selections.some(
            (selected) =>
              selected &&
              (!scope.agentId || selected.agentId === scope.agentId) &&
              (!scope.storePath ||
                selected.storePath === scope.storePath ||
                Boolean(scope.agentId)),
          );
      } else {
        changed ||= selections.some(
          (selected) =>
            selected &&
            (!change.agentId || selected.agentId === change.agentId) &&
            selected.sessionKey === change.sessionKey,
        );
      }
    });
    try {
      const outcome = await withSessionEntriesFromStoresInWorker([...groups.values()], (reads) => {
        readSignal?.throwIfAborted();
        operation.assertCurrent();
        if (
          changed ||
          accessRevision !== readGatewayAccessRevision() ||
          cfg !== options.context.getRuntimeConfig()
        ) {
          return { retry: true as const };
        }
        let active = true;
        try {
          const prepared = selections.map((selection): PreparedQuestionSession | undefined => {
            if (!selection) {
              return undefined;
            }
            const read = reads[keys.indexOf(selection.key)]!;
            const entry = read.result.entries.find(
              (row) => row.sessionKey === selection.sessionKey,
            )?.entry;
            const target: SessionSharingTarget | null = entry
              ? {
                  agentId: selection.agentId,
                  canonicalKey: selection.sessionKey,
                  storePath: selection.storePath,
                  storeKey: selection.sessionKey,
                  storeKeys: [selection.sessionKey],
                  entry,
                }
              : null;
            const assertCurrent = () => {
              if (
                !active ||
                changed ||
                cfg !== options.context.getRuntimeConfig() ||
                accessRevision !== readGatewayAccessRevision()
              ) {
                throw new Error("Question session preparation is no longer current");
              }
              read.assertCurrent();
              const identity = read.result.databaseIdentity;
              if (identity) {
                assertExistingDatabaseIdentity(read.database.path, `file:${identity.identity}`);
              }
              const currentCfg = options.context.getRuntimeConfig();
              if (
                resolveSessionStorePathForScope(
                  { agentId: selection.agentId, sessionKey: selection.sessionKey },
                  currentCfg,
                ) !== selection.storePath ||
                resolveStoredSessionKeyForAgentStore({ cfg: currentCfg, ...selection }) !==
                  selection.sessionKey
              ) {
                throw new Error("Question session route changed");
              }
            };
            const recipients = new Map<
              GatewayClient | null,
              ReturnType<typeof prepareSessionSharing>
            >();
            const sharingFor = (client: GatewayClient | null) => {
              if (client?.invalidated) {
                throw new Error("Question recipient is no longer current");
              }
              client?.internal?.operatorAccessAuthority?.assertCurrent();
              client?.internal?.operatorRunAuthority?.assertCurrent();
              let sharing = recipients.get(client);
              if (!sharing) {
                sharing = prepareQuestionSharing(
                  cfg,
                  client,
                  (selected, identityId) =>
                    read.result.members?.[selected.canonicalKey]?.some(
                      (member) => member.identityId === identityId,
                    ) ?? false,
                );
                recipients.set(client, sharing);
              }
              return sharing;
            };
            const preparedSession: PreparedQuestionSession = {
              target,
              read,
              assertCurrent,
              canAccess: (client, _access, narrow, binding = selection.binding) => {
                try {
                  if (narrow && binding) {
                    binding.assertCurrent(preparedSession);
                  } else {
                    assertCurrent();
                  }
                  if (!target) {
                    return false;
                  }
                  if (narrow) {
                    client?.internal?.operatorAccessAuthority?.assertCurrent();
                    client?.internal?.operatorRunAuthority?.assertCurrent();
                    if (
                      !binding?.canSelect(client) ||
                      authorizeCurrentOperatorRoleScopes(client, cfg) ||
                      target.entry.incognito ||
                      isIncognitoSessionKey(target.canonicalKey)
                    ) {
                      return false;
                    }
                    // Ordinary questions belong to their original requester, not other
                    // session viewers or members. Both reads and answers require write scope.
                    const actor = resolveGatewayOperatorRoleActor(client);
                    return (
                      actor?.kind === "operator" &&
                      !authorizeOwnSessionMutation({
                        client,
                        target,
                        expectedProfileId: actor.profileId,
                      })
                    );
                  }
                  return (
                    sharingFor(client).entryFilter?.(target.canonicalKey, target.entry) ?? true
                  );
                } catch {
                  return false;
                }
              },
              authorizeMutation: (client) => {
                assertCurrent();
                return target ? sharingFor(client).authorizeTarget(target) : null;
              },
              canReceive: (client) => {
                try {
                  // Original source/generation gates narrow question access above.
                  // Broad recipients retain the existing current-sharing contract.
                  assertCurrent();
                  return canReceiveSessionEvent({
                    cfg,
                    client,
                    sessionKeys: [selection.sessionKey],
                    agentId: selection.agentId,
                    prepared: { sharing: sharingFor(client), target: () => target },
                  });
                } catch {
                  return false;
                }
              },
            };
            return preparedSession;
          });
          const value = consume(prepared);
          if (isPromiseLike(value)) {
            void Promise.resolve(value).catch(() => {});
            throw new Error("Question session consumers must remain synchronous");
          }
          return { retry: false as const, value };
        } finally {
          active = false;
        }
      });
      if (!outcome.retry) {
        return outcome.value;
      }
    } finally {
      unsubscribe();
    }
  }
}

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
  access: "read" | "mutate",
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
    const allowed = prepared.canAccess(client, access, true, observation.sessionAccess);
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
      if (narrow) {
        authority.assertCurrent();
        const current = resolveGatewayOperatorRoleActor(options.client);
        if (
          actor?.kind !== "operator" ||
          current?.kind !== "operator" ||
          current.profileId !== actor.profileId ||
          !canAccessSessionQuestion(observation, prepared, options.client, access)
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
      if (!prepared?.canAccess(options.client, "read", false)) {
        return questionNotFound(id);
      }
      return access === "mutate" ? prepared.authorizeMutation(options.client) : null;
    },
  };
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
      if (usesOwnRunQuestionAccess(client)) {
        return canAccessSessionQuestion(observation, prepared, client, "read");
      }
      if (prepared) {
        return prepared.canReceive(client);
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
