import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import type { PreparedQuestionCallerRead } from "../agents/harness/host-private-capabilities.js";
import { withSessionEntriesFromStoresInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type {
  PreparedSessionEntryWorkerRead,
  SessionStoreWorkerReadScope,
} from "../config/sessions/session-entry-read-runtime.types.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { readUserProfileAliases } from "../state/user-profile-list.js";
import { readGatewayAccessRevision } from "./gateway-access-revision.js";
import {
  authorizeCurrentOperatorRoleScopes,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import type { QuestionSessionAccess } from "./question-session-access.types.js";
import { readGatewayRequestMutationAuthority } from "./server-methods/session-mutation-guards.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import {
  authorizeOwnSessionMutation,
  sharingIdentity,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { canReceiveSessionEvent } from "./session-sharing-read.js";
import { prepareSessionSharing } from "./session-sharing.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
export type QuestionTarget = {
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
    narrow: boolean,
    binding?: QuestionSessionAccess,
  ) => boolean;
  authorizeMutation: (
    client: GatewayClient | null,
  ) => ReturnType<ReturnType<typeof prepareSessionSharing>["authorizeTarget"]>;
  canReceive: (client: GatewayClient) => boolean;
};

export function prepareQuestionSharing(
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
  return withPreparedQuestionSessionOwner(
    options.context,
    readGatewayRequestMutationAuthority(options).questionCallerRead,
    questions,
    consume,
    operation,
  );
}

export async function withPreparedQuestionSessionOwner<T>(
  context: Pick<GatewayRequestContext, "getRuntimeConfig">,
  callerRead: PreparedQuestionCallerRead | undefined,
  questions: readonly QuestionTarget[],
  consume: (prepared: readonly (PreparedQuestionSession | undefined)[]) => T,
  operation: { assertCurrent: () => void; includeMembers?: boolean },
): Promise<T> {
  const signal = getAsyncWorkSignal();
  while (true) {
    operation.assertCurrent();
    const cfg = context.getRuntimeConfig();
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
        snapshotFields: readonly [];
        preparedSource?: SessionStoreWorkerReadScope["preparedSource"];
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
      const custody = question.sessionAccess?.durableCustody
        ? question.sessionAccess.durableBinding
        : undefined;
      if (custody && custody.agentId !== agentId) {
        return undefined;
      }
      const sessionKey =
        custody?.sessionKey ??
        resolveStoredSessionKeyForAgentStore({ cfg, agentId, sessionKey: question.sessionKey });
      const storePath =
        custody?.storePath ?? resolveSessionStorePathForScope({ agentId, sessionKey }, cfg);
      const key = JSON.stringify([
        agentId,
        storePath,
        custody?.databasePath,
        custody?.databaseIdentity,
      ]);
      const group = groups.get(key) ?? {
        agentId,
        storePath,
        sessionKeys: [],
        includeMembers: operation.includeMembers ?? false,
        includeAuthorization: true as const,
        snapshotFields: [] as const,
        ...(custody
          ? {
              preparedSource: {
                agentId,
                path: custody.databasePath,
                databaseIdentity: custody.databaseIdentity.identity,
                databaseBirthtime: custody.databaseIdentity.birthtime,
                assertCurrent: () => {
                  operation.assertCurrent();
                  question.sessionAccess?.assertSourceCurrent();
                },
              },
            }
          : {}),
      };
      group.sessionKeys.push(sessionKey);
      groups.set(key, group);
      return { key, agentId, sessionKey, storePath, binding: question.sessionAccess, custody };
    });
    // An empty batch completes locally after a waiter closes. Actual reads still
    // belong to the work scope; request authority is checked for both paths.
    const readSignal = groups.size > 0 || callerRead?.reads.length ? signal : undefined;
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
    const inputs = [...groups.values(), ...(callerRead?.reads ?? [])];
    try {
      const consumePrepared = (reads: readonly PreparedSessionEntryWorkerRead[]) => {
        readSignal?.throwIfAborted();
        operation.assertCurrent();
        if (
          changed ||
          accessRevision !== readGatewayAccessRevision() ||
          cfg !== context.getRuntimeConfig()
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
                cfg !== context.getRuntimeConfig() ||
                accessRevision !== readGatewayAccessRevision()
              ) {
                throw new Error("Question session preparation is no longer current");
              }
              read.assertCurrent();
              const identity = read.result.databaseIdentity;
              if (identity) {
                assertExistingDatabaseIdentity(read.database.path, `file:${identity.identity}`);
              }
              const currentCfg = context.getRuntimeConfig();
              if (
                !selection.custody &&
                (resolveSessionStorePathForScope(
                  { agentId: selection.agentId, sessionKey: selection.sessionKey },
                  currentCfg,
                ) !== selection.storePath ||
                  resolveStoredSessionKeyForAgentStore({ cfg: currentCfg, ...selection }) !==
                    selection.sessionKey)
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
              canAccess: (client, narrow, binding = selection.binding) => {
                try {
                  if ((narrow || binding?.durableCustody) && binding) {
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
                  if (selection.binding?.durableCustody) {
                    selection.binding.assertCurrent(preparedSession);
                  } else {
                    assertCurrent();
                  }
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
          callerRead?.assertPrepared(reads.slice(groups.size));
          operation.assertCurrent();
          const value = consume(prepared);
          if (isPromiseLike(value)) {
            void Promise.resolve(value).catch(() => {});
            throw new Error("Question session consumers must remain synchronous");
          }
          return { retry: false as const, value };
        } finally {
          active = false;
        }
      };
      const outcome = await withSessionEntriesFromStoresInWorker(inputs, consumePrepared, {
        ordered: Boolean(callerRead),
      });
      if (!outcome.retry) {
        return outcome.value;
      }
    } finally {
      unsubscribe();
    }
  }
}
