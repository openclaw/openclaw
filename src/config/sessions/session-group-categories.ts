import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { publishSessionEntryCacheCategoryUpdate } from "./session-accessor.sqlite-entry-cache.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import {
  applySessionGroupCategoryMutation,
  prepareSessionGroupCategoryMutation,
} from "./session-group-categories.kernel.js";
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
  if (scope.incognito) {
    const { actor, authority } = scope.incognito;
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
  const superseded = new Set<string>();
  let releasePublicationFence: (() => void) | undefined;
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
      const planned = prepareSessionGroupCategoryMutation(database, from);
      keys = [...planned.keys()];
      assertCurrent();
      return runOpenClawAgentWriteTransaction(
        (current) => {
          assertCurrent();
          return applySessionGroupCategoryMutation(
            current,
            planned,
            to,
            capturedScope.env ?? process.env,
          ).length;
        },
        options,
        { operationLabel: "session.group-categories.update" },
      );
    },
    (changed, location, database) => {
      releasePublicationFence?.();
      if (database) {
        publishSessionEntryCacheCategoryUpdate(
          database,
          changed.filter(({ sessionKey }) => !superseded.has(sessionKey)),
          to,
        );
      }
      sessionChanges.emitBatch(
        changed.map(({ sessionKey, sessionId }) => ({
          agentId: location.agentId,
          storePath: location.storePath,
          sessionKey,
          ...(superseded.has(sessionKey)
            ? { factsInvalidated: true as const }
            : { facts: { kind: "category" as const, sessionId, category: to?.trim() || null } }),
        })),
      );
      return changed.length;
    },
    assertCurrent,
    async (operation, preparedScope) => {
      keys = await operation.execute({
        type: "category.prepare",
        input: { scope: preparedScope, from },
      });
      assertCurrent();
      const targets = new Set(keys);
      // Legacy synchronous writers can publish after the worker commits but before its reply.
      // Reconcile those keys instead of replaying an older category over their newer facts.
      releasePublicationFence = sessionChanges.subscribeFacts((change) => {
        if ("all" in change) {
          for (const key of targets) {
            superseded.add(key);
          }
        } else if (
          targets.has(change.sessionKey) &&
          change.scope !== "automation" &&
          (change.factsInvalidated ||
            (change.facts &&
              change.facts.kind !== "unchanged" &&
              change.facts.kind !== "member" &&
              change.facts.kind !== "participants"))
        ) {
          superseded.add(change.sessionKey);
        }
      });
    },
    () => {
      // The prepared keys bound category writes, but a concurrent structural publication
      // requires the original store-wide fence. Our own recovery must not supersede itself.
      releasePublicationFence?.();
      return superseded.size === 0 ? keys : undefined;
    },
  ).finally(() => releasePublicationFence?.());
}
