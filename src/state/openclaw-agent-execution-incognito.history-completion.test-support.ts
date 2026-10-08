import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { bindCommandHarnessCompletionAssertion } from "../agents/agent-command-restart-recovery.js";
import { reconcileHarnessCompletionDelivery } from "../agents/agent-harness-completion-delivery.js";
import { createHarnessCompletionSourceAssertion } from "../agents/agent-harness-completion-recovery.js";
import type { HarnessCompletionRecovery } from "../config/sessions/restart-recovery-types.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { IncognitoEntryPatchResult } from "../config/sessions/session-incognito-entry-patch-contract.js";
import {
  prepareSessionSourceAuthority,
  runWithSessionSourceScope,
} from "../config/sessions/session-source-authority.js";
import { readActiveTranscriptEntryAnchorAsync } from "../config/sessions/session-transcript-anchor-read.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { HistoryWiringFixture } from "./openclaw-agent-execution-incognito.history-visibility.test-support.js";

type CompletionFixture = Pick<HistoryWiringFixture, "actor" | "authority" | "env" | "targetInput">;

async function createIncognitoCompletionClaim(
  fixture: CompletionFixture,
  name: string,
  owner: CompletionFixture["actor"],
  resumed: boolean,
) {
  const { authority, env, targetInput } = fixture;
  const sessionKey = `agent:${owner.agentId}:dashboard:incognito-${name}`;
  const claim: HarnessCompletionRecovery = {
    taskId: name,
    taskStatus: "succeeded",
    taskRunId: `task-${name}`,
    sourceRunId: `announce:${name}`,
    requesterSessionKey: sessionKey,
    requesterAgentId: owner.agentId,
    sessionId: name,
    lifecycleRevision: "initial",
  };
  const created = await owner.sessions.create(authority, {
    sessionKey,
    entry: {
      sessionId: name,
      createdAt: 10_000,
      updatedAt: 10_000,
      lifecycleRevision: "initial",
      incognito: true,
      restartRecoveryHarnessCompletion: claim,
      restartRecoveryDeliveryRunId: resumed ? "recovery" : claim.sourceRunId,
      restartRecoveryDeliverySourceRunId: claim.sourceRunId,
    },
  });
  assert(created.entry);
  const session = { sessionKey, entry: created.entry };
  const target = targetInput(session);
  const scope = { ...target, agentId: owner.agentId, storePath: owner.path, env };
  return { claim, session, target, scope };
}

export async function createIncognitoCompletionSource(
  fixture: CompletionFixture,
  name: string,
  owner = fixture.actor,
) {
  const { authority } = fixture;
  const { claim, session, target, scope } = await createIncognitoCompletionClaim(
    fixture,
    name,
    owner,
    true,
  );
  const source = await owner.sessions.transcript(authority, {
    type: "session.message.append",
    input: {
      ...target,
      fence: { expectedLifecycleRevision: target.lifecycleRevision },
      message: {
        role: "user",
        content: "completed task",
        idempotencyKey: `${claim.sourceRunId}:user`,
        __openclaw: { runId: claim.sourceRunId },
        provenance: {
          kind: "inter_session",
          sourceChannel: "internal",
          sourceTool: "agent_harness_completion",
          sourceSessionKey: claim.taskRunId,
        },
      },
    },
  });
  assert(source.ok && source.value.append);
  const recovery = await owner.sessions.transcript(authority, {
    type: "session.message.append",
    input: {
      ...target,
      fence: { expectedLifecycleRevision: target.lifecycleRevision },
      message: {
        role: "user",
        content: "resume delivery",
        idempotencyKey: "recovery:user",
        provenance: {
          kind: "internal_system",
          sourceTool: "main_session_restart_recovery",
          sourceSessionKey: target.sessionKey,
        },
      },
    },
  });
  assert(recovery.ok && recovery.value.append);
  const anchor = await readActiveTranscriptEntryAnchorAsync(
    { ...scope, entryId: recovery.value.append.messageId },
    undefined,
    { actor: owner, authority, target },
  );
  assert(anchor);
  return { claim, session, target, scope, anchor };
}

export function registerIncognitoCompletionTests(fixture: CompletionFixture) {
  const { authority } = fixture;
  it("requires committed input before retaining cold original-run completion custody", async () => {
    const { actor } = fixture;
    const { claim, target, scope } = await createIncognitoCompletionClaim(
      fixture,
      "cold-original-claim",
      actor,
      false,
    );
    await withIncognitoSessionActor(actor, async () => {
      const reconcile = () =>
        reconcileHarnessCompletionDelivery({ ...scope, sourceRunId: claim.sourceRunId });
      expect(await reconcile()).toBe("blocked");
      const appended = await actor.sessions.transcript(authority, {
        type: "session.message.append",
        input: {
          ...target,
          fence: { expectedLifecycleRevision: target.lifecycleRevision },
          message: {
            role: "user",
            content: "Completed task ready for recovery",
            idempotencyKey: `${claim.sourceRunId}:user`,
            __openclaw: { runId: claim.sourceRunId },
            provenance: {
              kind: "inter_session",
              sourceChannel: "internal",
              sourceTool: "agent_harness_completion",
              sourceSessionKey: claim.taskRunId,
            },
          },
        },
      });
      assert(appended.ok);
      expect(await reconcile()).toBe("pending");
    });
  });

  it.each([true, false])(
    "binds resumed command completion only with valid source input=%s",
    async (validInput) => {
      const { actor } = fixture;
      const { claim, session, target } = await createIncognitoCompletionSource(
        fixture,
        `command-binding-${validInput}`,
      );
      expect(session.entry.restartRecoveryDeliveryRunId).not.toBe(claim.sourceRunId);
      if (!validInput) {
        const appended = await actor.sessions.transcript(authority, {
          type: "session.message.append",
          input: {
            ...target,
            fence: { expectedLifecycleRevision: target.lifecycleRevision },
            message: { role: "user", content: "New human input supersedes the completion" },
          },
        });
        assert(appended.ok);
      }
      await withIncognitoSessionActor(actor, async () => {
        let callerCurrent = true;
        const binding = Promise.resolve().then(() =>
          bindCommandHarnessCompletionAssertion({
            claim,
            persisted: session.entry,
            sessionKey: target.sessionKey,
            storePath: actor.path,
            opts: {
              message: "Resume the saved completion",
              assertSourceCurrent() {
                if (!callerCurrent) {
                  throw new Error("command source caller revoked");
                }
              },
            },
          }),
        );
        if (!validInput) {
          await expect(binding).rejects.toThrow(
            "Incognito harness completion source is no longer current",
          );
          return;
        }
        const bound = await binding;
        assert(bound.source);
        try {
          bound.opts.assertSourceCurrent?.();
          callerCurrent = false;
          expect(bound.opts.assertSourceCurrent).toThrow("command source caller revoked");
        } finally {
          await bound.source.release();
        }
      });
    },
  );

  it("releases an exact completion source only after accepted native work settles", async () => {
    const { actor } = fixture;
    const { claim, anchor } = await createIncognitoCompletionSource(fixture, "source-release");
    const source = await withIncognitoSessionActor(actor, () =>
      runWithSessionTranscriptReadFence(
        { ...anchor, logicalTurnId: "recovery", role: "user" },
        () =>
          prepareSessionSourceAuthority(
            createHarnessCompletionSourceAssertion({ claim, storePath: actor.path }),
          ),
      ),
    );
    source.assertCurrent();
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const order: string[] = [];
    const accepted = actor.run({ assertCurrent: source.assertCurrent }, async (native) => {
      await native.execute({ type: "database.incognito.memory", input: undefined });
      entered.resolve();
      await resume.promise;
      order.push("native-settled");
    });
    const settled = expect(accepted).rejects.toThrow("completion source is no longer current");
    await awaitGateBeforeSettlement(
      entered.promise,
      accepted,
      "Source consumer did not enter native work",
    );
    assert(source.release);
    const releasing = Promise.resolve(source.release()).then(() => order.push("source-released"));
    try {
      expect(source.assertCurrent).toThrow("completion source is no longer current");
      await Promise.resolve();
      expect(order).toEqual([]);
      resume.resolve();
      await Promise.all([settled, releasing]);
      expect(order).toEqual(["native-settled", "source-released"]);
    } finally {
      resume.resolve();
      await Promise.allSettled([accepted, settled, releasing]);
    }
  });

  it.each(["fenced-input", "unfenced-input", "assistant", "reset", "branch", "rewrite"] as const)(
    "retains the exact harness completion source across %s without host SQL",
    async (change) => {
      const { actor } = fixture;
      const name = `completion-${change}`;
      const { claim, target, anchor } = await createIncognitoCompletionSource(fixture, name);
      await withIncognitoSessionActor(actor, async () => {
        const assertion = createHarnessCompletionSourceAssertion({ claim, storePath: actor.path });
        const admission =
          change === "unfenced-input"
            ? undefined
            : { ...anchor, logicalTurnId: "recovery", role: "user" as const };
        let observedInvalidation = false;
        const work = runWithSessionTranscriptReadFence(admission, () =>
          runWithSessionSourceScope(assertion, async () => {
            assertion();
            if (change === "reset") {
              const current = await actor.sessions.read(authority, {
                sessionKey: target.sessionKey,
              });
              assert(current.entry);
              const reset = await deleteSessionEntryLifecycle({
                kind: "incognito",
                actor,
                authority,
                env: fixture.env,
                target: { sessionKey: target.sessionKey, entry: current.entry },
                reason: "reset",
              });
              expect(reset.deleted).toBe(true);
            } else if (change === "branch") {
              const branch = await actor.sessions.transcript(authority, {
                type: "session.manager.transcript.branch",
                input: {
                  sessionKey: target.sessionKey,
                  command: {
                    type: "session.transcript.branch",
                    input: {
                      scope: { ...target, agentId: actor.agentId, storePath: actor.path },
                      branch: { sessionId: `${name}-branch`, events: [] },
                      expectedLifecycleRevision: target.lifecycleRevision,
                    },
                  },
                },
              });
              expect(branch.ok).toBe(true);
            } else {
              const result = await actor.sessions.transcript(authority, {
                type: "session.message.append",
                input: {
                  ...target,
                  fence: { expectedLifecycleRevision: target.lifecycleRevision },
                  ...(change === "rewrite" ? { parentId: null } : {}),
                  message: {
                    role: change.endsWith("input") ? "user" : "assistant",
                    content: "later input or own answer",
                  },
                },
              });
              assert(result.ok);
            }
            if (change === "assistant" || change === "fenced-input") {
              assertion();
              // The same exact fence must also hold inside its own append transaction.
              const guarded = await actor.sessions.transcript(
                { assertCurrent: assertion },
                {
                  type: "session.message.append",
                  input: {
                    ...target,
                    fence: { expectedLifecycleRevision: target.lifecycleRevision },
                    message: { role: "assistant", content: "fenced answer" },
                  },
                },
              );
              expect(guarded.ok).toBe(true);
            } else {
              expect(assertion).toThrow();
              observedInvalidation = true;
            }
          }),
        );
        if (change === "assistant" || change === "fenced-input") {
          await work;
        } else {
          await expect(work).rejects.toThrow();
          expect(observedInvalidation).toBe(true);
        }
      });
    },
  );

  it.each(["delivered", "blocked"] as const)(
    "reconciles a %s completion committed ahead of its queued history read",
    async (expected) => {
      const { actor } = fixture;
      const { claim, scope } = await createIncognitoCompletionSource(
        fixture,
        `reconcile-${expected}`,
      );
      const selection = { kind: "entry" as const, sessionKey: scope.sessionKey, exact: true };
      const prepared = await actor.sessions.entry(authority, {
        type: "session.entry.patch.prepare",
        input: { sessionKey: scope.sessionKey, selection },
      });
      const writeBase = prepared[0]?.entry;
      assert(writeBase);
      const next: SessionEntry = {
        ...writeBase,
        restartRecoveryHarnessCompletion: undefined,
        ...(expected === "delivered"
          ? {
              restartRecoveryTerminalDeliveryEvidence: [
                {
                  runId: claim.sourceRunId,
                  harnessCompletion: claim,
                  deliveryContext: { channel: "slack", to: "channel:synthetic" },
                  deliveryStatus: { status: "sent", resultCount: 1 },
                  payloads: [{ visible: true }],
                },
              ],
            }
          : {}),
      };
      const queued = createDeferredCore();
      const resume = createDeferredCore();
      let held: Promise<void> | undefined;
      let mutation: Promise<IncognitoEntryPatchResult> | undefined;
      const history = actor.sessions.history;
      const observer = vi.spyOn(actor.sessions, "history").mockImplementation((...args) => {
        // All three operations reserve this actor's FIFO before the barrier opens.
        held = actor.run(authority, () => resume.promise);
        mutation = actor.sessions.entry(authority, {
          type: "session.entry.patch.commit",
          input: {
            sessionKey: scope.sessionKey,
            selection,
            prepared,
            writeBase,
            next,
            operationLabel: "session-entry.patch",
            validateCanonicalKeys: true,
          },
        });
        const reading = history(...args);
        queued.resolve();
        return reading;
      });
      const reconciliation = withIncognitoSessionActor(actor, () =>
        reconcileHarnessCompletionDelivery({ ...scope, sourceRunId: claim.sourceRunId }),
      );
      try {
        await awaitGateBeforeSettlement(
          queued.promise,
          reconciliation,
          "Reconciler did not queue its completion history read",
        );
        resume.resolve();
        expect((await mutation)?.wrote).toBe(true);
        expect(await reconciliation).toBe(expected);
      } finally {
        resume.resolve();
        observer.mockRestore();
        await Promise.allSettled([held, mutation, reconciliation]);
      }
    },
  );
}
