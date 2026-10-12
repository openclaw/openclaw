import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { resolveSessionStorePathCore } from "./paths.js";
import type {
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
} from "./session-accessor.sqlite-contract.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  captureIncognitoSessionOperation,
  captureIncognitoSessionSource,
} from "./session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type {
  IncognitoLifecycleEntry,
  IncognitoLifecycleOperations,
} from "./session-incognito-lifecycle-contract.js";
import { captureSessionTranscriptTargetBinding } from "./transcript-target-binding.js";

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
    expectedPluginOwnerId?: string;
    expectedAgentHarnessId?: string;
  },
): Promise<IncognitoLifecycleOperations["session.lifecycle.delete"]["output"]> {
  const { actor, authority, scope } = captureLifecycle(params);
  const target = structuredClone(params.target);
  const reason = params.reason;
  const expectedPluginOwnerId = params.expectedPluginOwnerId;
  const expectedAgentHarnessId = params.expectedAgentHarnessId;
  return actor.sessions.withSharedState(async () => {
    const [
      { withSqliteSessionDeletions },
      { collectActiveSessionWorkAdmissions },
      { publishCommittedSessionEntryRemoval },
    ] = await Promise.all([
      import("./session-accessor.sqlite-deletion.js"),
      import("../../sessions/session-lifecycle-admission.js"),
      import("./session-accessor.sqlite-identity.js"),
    ]);
    return withSqliteSessionDeletions(
      scope,
      [target],
      async (assertDeletionCurrent, capture, settleReceipts) => {
        const current: IncognitoSessionAuthority = {
          assertCurrent() {
            authority.assertCurrent();
            actor.assertCurrent();
            assertDeletionCurrent();
          },
          authorize: (stage, facts) => authority.authorize?.(stage, facts),
        };
        const result = await actor.sessions.lifecycle(
          current,
          {
            type: "session.lifecycle.delete",
            input: {
              target,
              reason,
              expectedPluginOwnerId,
              expectedAgentHarnessId,
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
          await settleReceipts(() => {
            actor.assertCurrent();
            absent.assertCurrent();
          });
        }
        return result;
      },
      {
        incognito: actor,
        receiptsOnCommit: {
          generations: [
            {
              agentId: actor.agentId,
              sessionKey: target.sessionKey,
              sessionId: target.entry.sessionId,
              lifecycleRevision: target.entry.lifecycleRevision ?? null,
            },
          ],
        },
      },
    );
  });
}

/** Reclamation plans are prepared off-lock and rechecked in the actor's synchronous transaction. */
export function reclaimIncognitoSessionLifecycle(
  params: IncognitoLifecycleTarget & {
    input: IncognitoLifecycleOperations["session.lifecycle.reclaim.prepare"]["input"];
    admissionSignal?: AbortSignal;
  },
): Promise<IncognitoLifecycleOperations["session.lifecycle.reclaim"]["output"]> {
  const { actor, authority, scope } = captureLifecycle(params);
  const input = structuredClone(params.input);
  const { admissionSignal } = params;
  admissionSignal?.throwIfAborted();
  return actor.sessions.withSharedState(async () => {
    const plan = await actor.sessions.lifecycle(
      authority,
      { type: "session.lifecycle.reclaim.prepare", input },
      admissionSignal,
    );
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
      (assertDeletionCurrent, capture) => {
        admissionSignal?.throwIfAborted();
        return actor.sessions.lifecycle(
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
        );
      },
      {
        incognito: actor,
        additionalIdentities: plan.deletePlans.map((deletePlan) => deletePlan.sessionId),
      },
    );
  });
}

export function deleteCapturedIncognitoSession(
  params: DeleteSessionEntryLifecycleParams,
  expectedPluginOwnerId?: string,
  expectedAgentHarnessId?: string,
): Promise<DeleteSessionEntryLifecycleResult> | undefined {
  const source = captureIncognitoSessionSource({
    ...params,
    sessionKey: params.target.canonicalKey,
  });
  if (source && "kind" in source) {
    params.commitGuard?.();
    source.assertCurrent();
    return Promise.resolve({
      deleted: false,
      archivedTranscripts: [],
      ...((params.expectedEntry ||
        params.expectedSessionId != null ||
        params.expectedLifecycleRevision !== undefined ||
        params.expectedUpdatedAt !== undefined) && { expectedEntryMismatch: true as const }),
    });
  }
  const binding = captureIncognitoSessionOperation({
    ...params,
    sessionKey: params.target.canonicalKey,
  });
  if (binding) {
    const captured = {
      ...params,
      target: structuredClone(params.target),
      expectedEntry: params.expectedEntry && structuredClone(params.expectedEntry),
      env: captureSessionTranscriptTargetBinding({
        storePath: binding.actor.path,
        agentId: binding.actor.agentId,
        env: params.env,
      }).env,
    };
    const authority = {
      assertCurrent() {
        binding.authority.assertCurrent();
        captured.commitGuard?.();
      },
    };
    return binding.actor.sessions.withSharedState(async () => {
      const { entry } = await binding.actor.sessions.read(
        authority,
        { sessionKey: captured.target.canonicalKey },
        binding.admissionSignal,
      );
      if (
        (captured.expectedEntry && !sqliteSessionEntriesEqual(entry, captured.expectedEntry)) ||
        (captured.expectedSessionId !== undefined &&
          (entry?.sessionId ?? null) !== captured.expectedSessionId) ||
        (captured.expectedLifecycleRevision !== undefined &&
          entry?.lifecycleRevision !== captured.expectedLifecycleRevision) ||
        (captured.expectedUpdatedAt !== undefined &&
          entry?.updatedAt !== captured.expectedUpdatedAt)
      ) {
        return { deleted: false, archivedTranscripts: [], expectedEntryMismatch: true as const };
      }
      if (!entry) {
        return { deleted: false, archivedTranscripts: [] };
      }
      binding.admissionSignal?.throwIfAborted();
      return deleteIncognitoSessionLifecycle({
        actor: binding.actor,
        authority,
        env: captured.env,
        ownerStorePath: captured.storePath,
        target: { sessionKey: captured.target.canonicalKey, entry },
        reason: "deleted",
        expectedPluginOwnerId,
        expectedAgentHarnessId,
      });
    });
  }
  return undefined;
}
