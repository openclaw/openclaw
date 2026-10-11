import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { bindSessionEntryPublicationSource } from "./session-accessor.sqlite-entry-cache-publication.js";
import { publishSessionEntryCacheCategoryUpdate } from "./session-accessor.sqlite-entry-cache.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import { applySessionGroupCategoryMutation } from "./session-group-categories.kernel.js";
import { readSessionGroupCategoryKeys } from "./session-group-categories.read.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";
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
  const incognito = scope.incognito ?? captureIncognitoSessionOperation(scope);
  if (incognito) {
    const { actor, authority } = incognito;
    const resolved = resolveSqliteScope(scope);
    const options = toDatabaseOptions(resolved);
    if (actor.agentId !== resolved.agentId || actor.path !== options.path) {
      return Promise.reject(new Error("Category target differs from its captured incognito actor"));
    }
    return actor.sessions
      .sideData(
        {
          assertCurrent() {
            authority.assertCurrent();
            actor.assertCurrent();
          },
          authorize(stage, facts) {
            assertTargetCurrent?.({ agentId, sessionKey: facts.sessionKey });
            return authority.authorize?.(stage, facts);
          },
        },
        { type: "session.category.apply", input: { from, to } },
        undefined,
        (changed) => {
          sessionChanges.emitBatch(
            changed.map(({ sessionKey, sessionId }) => ({
              agentId,
              storePath: actor.path,
              sessionKey,
              facts: { kind: "category" as const, sessionId, category: to?.trim() || null },
            })),
          );
        },
        (facts) => {
          sessionChanges.emitBatch(
            facts.map(({ sessionKey }) => ({
              agentId,
              storePath: actor.path,
              sessionKey,
              factsInvalidated: "category" as const,
            })),
          );
        },
      )
      .then((changed) => changed.length);
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
    (capturedScope) => {
      const options = toDatabaseOptions(resolveSqliteScope(capturedScope));
      const database = openOpenClawAgentDatabase(options);
      const planned = readSessionGroupCategoryKeys(database, from);
      keys = planned;
      assertCurrent();
      return runOpenClawAgentWriteTransaction(
        (current) => {
          assertCurrent();
          return applySessionGroupCategoryMutation(
            current,
            planned,
            from,
            to,
            capturedScope.env ?? process.env,
          ).length;
        },
        options,
        { operationLabel: "session.group-categories.update" },
      );
    },
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
