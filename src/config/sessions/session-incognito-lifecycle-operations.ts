import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { resolveSessionStorePathCore } from "./paths.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type {
  IncognitoLifecycleEntry,
  IncognitoLifecycleOperations,
} from "./session-incognito-lifecycle-contract.js";

type IncognitoLifecycleTarget = {
  actor: Pick<
    IncognitoAgentDatabaseExecution,
    "agentId" | "path" | "identity" | "sessions" | "assertCurrent"
  >;
  authority: IncognitoSessionAuthority;
  env: NodeJS.ProcessEnv;
  ownerStorePath?: string;
};

function captureLifecycle(params: IncognitoLifecycleTarget) {
  const { actor, authority } = params;
  const env = cloneEnvWithPlatformSemantics(params.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  actor.assertCurrent();
  authority.assertCurrent();
  if (actor.path !== resolveIncognitoOpenClawAgentSqlitePath({ agentId: actor.agentId, env })) {
    throw new Error("Incognito lifecycle environment differs from its captured actor");
  }
  return {
    actor,
    authority,
    scope: {
      agentId: actor.agentId,
      path: actor.path,
      env,
      ownerStorePath:
        params.ownerStorePath ??
        resolveSessionStorePathCore(undefined, { agentId: actor.agentId, env }),
    },
  };
}

/** Hooks and companion settlement keep the existing deletion owner around the actor transaction. */
export function deleteIncognitoSessionLifecycle(
  params: IncognitoLifecycleTarget & {
    target: IncognitoLifecycleEntry;
    reason: "reset" | "deleted";
  },
): Promise<IncognitoLifecycleOperations["session.lifecycle.delete"]["output"]> {
  const { actor, authority, scope } = captureLifecycle(params);
  const target = structuredClone(params.target);
  const reason = params.reason;
  return actor.sessions.withSharedState(async () => {
    const [
      { withSqliteSessionDeletions },
      { collectActiveSessionWorkAdmissions },
      { preparePersonalGitHubSessionReceiptDeletion },
      { publishCommittedSessionEntryRemoval },
    ] = await Promise.all([
      import("./session-accessor.sqlite-deletion.js"),
      import("../../sessions/session-lifecycle-admission.js"),
      import("../../state/github-personal-publication-lifecycle.js"),
      import("./session-accessor.sqlite-identity.js"),
    ]);
    return withSqliteSessionDeletions(
      scope,
      [target],
      async (assertDeletionCurrent, capture) => {
        const current: IncognitoSessionAuthority = {
          assertCurrent() {
            authority.assertCurrent();
            actor.assertCurrent();
            assertDeletionCurrent();
          },
          authorize: (stage, facts) => authority.authorize?.(stage, facts),
        };
        const deleteReceipts = await preparePersonalGitHubSessionReceiptDeletion({
          agentId: actor.agentId,
          env: scope.env,
          generations: [
            {
              sessionKey: target.sessionKey,
              sessionId: target.entry.sessionId,
              lifecycleRevision: target.entry.lifecycleRevision ?? null,
            },
          ],
          assertCurrent: () => current.assertCurrent(),
        });
        const result = await actor.sessions.lifecycle(
          current,
          {
            type: "session.lifecycle.delete",
            input: {
              target,
              reason,
              admissionIdentities: [
                ...(collectActiveSessionWorkAdmissions().get(scope.ownerStorePath ?? actor.path) ??
                  []),
              ],
            },
          },
          undefined,
          (entries) => {
            const settlement = capture(entries);
            return {
              beforeCommit: () => settlement.beforeCommit(),
              settle(outcome) {
                try {
                  settlement.settle(outcome);
                } finally {
                  if (outcome === "committed") {
                    publishCommittedSessionEntryRemoval(
                      actor.agentId,
                      actor.identity.incarnation,
                      target.entry.sessionId,
                      [target.sessionKey],
                    );
                  }
                }
              },
            };
          },
        );
        if (result.deleted) {
          const absent = actor.sessions.captureSnapshot(target.sessionKey);
          await deleteReceipts(() => {
            actor.assertCurrent();
            absent.assertCurrent();
          });
        }
        return result;
      },
      { incognito: actor },
    );
  });
}

/** Reclamation plans are prepared off-lock and rechecked in the actor's synchronous transaction. */
export function reclaimIncognitoSessionLifecycle(
  params: IncognitoLifecycleTarget & {
    input: IncognitoLifecycleOperations["session.lifecycle.reclaim.prepare"]["input"];
  },
): Promise<IncognitoLifecycleOperations["session.lifecycle.reclaim"]["output"]> {
  const { actor, authority, scope } = captureLifecycle(params);
  const input = structuredClone(params.input);
  return actor.sessions.withSharedState(async () => {
    const plan = await actor.sessions.lifecycle(authority, {
      type: "session.lifecycle.reclaim.prepare",
      input,
    });
    const entries = plan.entries.flatMap(({ sessionKey, expectedEntry }) =>
      expectedEntry ? [{ sessionKey, entry: expectedEntry }] : [],
    );
    const [{ withSqliteSessionDeletions }, { prepareCommittedSessionEntryRemovals }] =
      await Promise.all([
        import("./session-accessor.sqlite-deletion.js"),
        import("./session-accessor.sqlite-identity.js"),
      ]);
    const publish = prepareCommittedSessionEntryRemovals(
      actor.agentId,
      actor.identity.incarnation,
      plan.entries,
    );
    return withSqliteSessionDeletions(
      scope,
      entries,
      (assertDeletionCurrent, capture) =>
        actor.sessions.lifecycle(
          {
            assertCurrent() {
              authority.assertCurrent();
              actor.assertCurrent();
              assertDeletionCurrent();
            },
            authorize: (stage, facts) => authority.authorize?.(stage, facts),
          },
          { type: "session.lifecycle.reclaim", input: { plan } },
          undefined,
          (checkedEntries) => {
            const settlement = capture(checkedEntries);
            return {
              beforeCommit: () => settlement.beforeCommit(),
              settle(outcome) {
                try {
                  settlement.settle(outcome);
                } finally {
                  if (outcome === "committed") {
                    publish();
                  }
                }
              },
            };
          },
        ),
      {
        incognito: actor,
        additionalIdentities: plan.deletePlans.map((deletePlan) => deletePlan.sessionId),
      },
    );
  });
}
