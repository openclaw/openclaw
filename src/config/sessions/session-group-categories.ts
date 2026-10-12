import {
  ensureSessionGroupCatalog,
  readSessionGroupCatalog,
} from "../../gateway/session-group-catalog.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { bindSessionEntryPublicationSource } from "./session-accessor.sqlite-entry-cache-publication.js";
import { publishSessionEntryCacheCategoryUpdate } from "./session-accessor.sqlite-entry-cache.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "./session-actor-storage-binding.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import { runSessionCollaborationWrite } from "./session-sharing-store.async.js";

/** Prepared rows stay with the broker; only target identities cross the admission boundary. */
export function updateSessionGroupCategoriesInWorker(params: {
  scope: SessionCollaborationScope & { agentId: string };
  from: string;
  to?: string;
  assertTargetCurrent?: (target: { agentId: string; sessionKey: string }) => void;
}): Promise<number> {
  const { scope, from, to, assertTargetCurrent } = params;
  const agentId = scope.agentId;
  const owner = captureSessionActorStorageOwner(scope, { assertCurrent() {}, authorize() {} });
  if (owner) {
    return (async () => {
      const ownerSessionKey =
        owner.owner?.listSessions(owner.authority)[0]?.target.sessionKey ??
        (owner.binding?.agentId === owner.agentId && owner.binding.path === owner.path
          ? owner.binding.actor.target.sessionKey
          : undefined);
      if (!ownerSessionKey) {
        return 0;
      }
      if (to !== undefined) {
        await ensureSessionGroupCatalog(scope.env ?? process.env);
      }
      return (
        (await withSessionActorStorage(
          { ...scope, sessionKey: ownerSessionKey },
          {
            authority: owner.authority,
            lifetime: {
              assertCurrent: () => owner.authority.assertCurrent(),
              assertReadable: () => owner.authority.assertCurrent(),
            },
          },
          async (memory) => {
            const outcome = await memory.actor.storage.mutate(
              { type: "session.category.apply", input: { from, to } },
              {
                assertCurrent() {
                  memory.authority.assertCurrent();
                  if (
                    to !== undefined &&
                    !readSessionGroupCatalog(scope.env).groups.some((group) => group.name === to)
                  ) {
                    throw new Error(`unknown session group: ${to}`);
                  }
                },
                authorize(stage, facts, publication) {
                  assertTargetCurrent?.({ agentId, sessionKey: facts.target.sessionKey });
                  memory.authority.authorize(stage, facts, publication);
                },
              },
              {
                committed({ value }) {
                  sessionChanges.emitBatch(
                    value.map(({ sessionKey, sessionId }) => ({
                      agentId,
                      storePath: memory.path,
                      sessionKey,
                      facts: { kind: "category" as const, sessionId, category: to?.trim() || null },
                    })),
                  );
                },
              },
            );
            if (outcome.kind === "rolled-back" || outcome.failure) {
              const failure = outcome.kind === "rolled-back" ? outcome.error : outcome.failure!;
              const error = new Error(failure.message);
              error.name = failure.name;
              throw error;
            }
            return outcome.value.length;
          },
        )) ?? 0
      );
    })();
  }
  let keys: string[] = [];
  const assertCurrent = () => {
    for (const sessionKey of keys) {
      assertTargetCurrent?.({ agentId, sessionKey });
    }
  };
  return runSessionCollaborationWrite(
    scope,
    { type: "category.apply", input: { scope, from, to } },
    (changed, location, database, currentKeys) => {
      const current = currentKeys
        ? changed.filter(({ sessionKey }) => currentKeys.has(sessionKey))
        : changed;
      if (database) {
        publishSessionEntryCacheCategoryUpdate(database, current, to);
      }
      const changes = current.map(({ sessionKey, sessionId }) => ({
        agentId: location.agentId,
        storePath: location.storePath,
        sessionKey,
        facts: { kind: "category" as const, sessionId, category: to?.trim() || null },
      }));
      if (database) {
        for (const change of changes) {
          bindSessionEntryPublicationSource(change, database);
        }
      }
      sessionChanges.emitBatch(changes, database?.db);
      return changed.length;
    },
    assertCurrent,
    async (operation, preparedScope) => {
      keys = await operation.execute({
        type: "category.prepare",
        input: { scope: preparedScope, from },
      });
      assertCurrent();
    },
  );
}
