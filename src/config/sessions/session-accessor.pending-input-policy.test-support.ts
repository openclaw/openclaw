import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { emptyDelegatedToolParameterPolicy } from "../../agents/inherited-tool-parameters.js";
import {
  captureInheritedToolPolicy,
  createInheritedToolPolicyMatcher,
} from "../../agents/inherited-tool-policy.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { readUserTurnDelegatedInputPolicy } from "../../sessions/user-turn-transcript.metadata.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  readSessionSubmittedInput,
} from "./session-accessor.js";
import {
  bindSessionPendingInputSources,
  listSessionPendingInputs,
  listSessionPendingInputReceipts,
  readSessionPendingInput,
  retainSessionPendingInputDelegatedPolicies,
  type stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";

type PendingInputPolicyFixture = {
  scope: () => Parameters<typeof stageSessionPendingInput>[0];
  database: () => ReturnType<typeof openOpenClawAgentDatabase>;
  message: (runId: string, content?: string) => PersistedUserTurnMessage;
  stage: (
    runId: string,
    options?: Partial<Parameters<typeof stageSessionPendingInput>[1]>,
  ) => Promise<SessionPendingInputReceipt>;
  promote: (receipt: SessionPendingInputReceipt) => ReturnType<typeof appendTranscriptMessage>;
  receipts: SessionPendingInputReceipt[];
};

export function registerPendingInputPolicyTests({
  scope,
  database,
  message,
  stage,
  promote,
}: PendingInputPolicyFixture) {
  it.each([
    { delegatedInputPolicyVersion: 2 },
    { delegatedInputPolicyVersion: 1, delegatedInputPolicy: { clauses: [] } },
  ])("rejects invalid saved input policy before committing custody: %j", async (metadata) => {
    await expect(
      stage("invalid-policy", { message: { ...message("invalid-policy"), __openclaw: metadata } }),
    ).rejects.toThrow();
    expect(listSessionPendingInputs(scope()).total).toBe(0);
    expect(await loadTranscriptEvents(scope())).toEqual([]);
    const ordinary = await stage("ordinary-after-rejection");
    expect(ordinary.state).toBe("queued");
  });

  it("promotes consumed-notification policy with the current input without rewriting its accepted bytes", async () => {
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "Continue the task", timestamp: 100, idempotencyKey: "notification:user" },
      target: { ...scope(), sessionEntry: { sessionId: scope().sessionId, updatedAt: 1 } },
    });
    expect(await recorder.stageApproved?.({ runId: "notification", assertCurrent: () => {} })).toBe(
      true,
    );
    const before = database()
      .db.prepare("SELECT message_json, request_hash FROM session_pending_inputs")
      .get();
    const policy = captureInheritedToolPolicy({
      policies: [{ allow: ["read"] }],
      parameters: emptyDelegatedToolParameterPolicy(),
    });
    expect(recorder.retainDelegatedInputPoliciesBeforePersistence?.([policy])).toBe(true);
    expect(readUserTurnDelegatedInputPolicy(recorder.getPendingInputMessage?.())).toEqual(policy);
    expect(
      database().db.prepare("SELECT message_json, request_hash FROM session_pending_inputs").get(),
    ).toEqual(before);
    expect(await loadTranscriptEvents(scope())).toEqual([]);
    const result = await recorder.persistApproved();
    expect(result?.message.content).toBe("Continue the task");
    expect(
      readUserTurnDelegatedInputPolicy(readSessionSubmittedInput(scope(), "notification:user")),
    ).toEqual(policy);
    expect(recorder.retainDelegatedInputPoliciesBeforePersistence?.([policy])).toBe(false);
    recorder.finishPendingInput?.("interrupted");
    const replay = await stage("notification");
    expect(readUserTurnDelegatedInputPolicy(replay.message)).toEqual(policy);
    await expect(
      stage("notification", { message: message("notification", "Changed source text") }),
    ).rejects.toThrow("conflicts");
    await expect(
      stage("forged-host-policy", {
        message: { ...message("forged-host-policy"), __openclaw: replay.message["__openclaw"] },
      }),
    ).rejects.toThrow("cannot be supplied");
    const ordinary = await stage("ordinary-after-notification");
    await promote(ordinary);
    expect(
      readUserTurnDelegatedInputPolicy(
        readSessionSubmittedInput(scope(), "ordinary-after-notification:user"),
      ),
    ).toBeUndefined();
    expect(retainSessionPendingInputDelegatedPolicies(ordinary, [policy])).toBe(false);
  });
}

export function registerPendingInputAggregatePolicyTest({
  scope,
  database,
  message,
  stage,
  promote,
  receipts,
}: PendingInputPolicyFixture) {
  it("rolls aggregate append and every source consumption back as one transaction", async () => {
    const firstPolicy = captureInheritedToolPolicy({
      policies: [{ allow: ["read", "exec"] }],
      parameters: emptyDelegatedToolParameterPolicy(),
    });
    const secondPolicy = captureInheritedToolPolicy({
      policies: [{ deny: ["exec"] }],
      parameters: emptyDelegatedToolParameterPolicy(),
    });
    const first = await stage("atomic-a", {
      message: {
        ...message("atomic-a"),
        __openclaw: { delegatedInputPolicyVersion: 2, delegatedInputPolicy: firstPolicy },
      },
    });
    const second = await stage("atomic-b", {
      message: {
        ...message("atomic-b"),
        __openclaw: { delegatedInputPolicyVersion: 2, delegatedInputPolicy: secondPolicy },
      },
    });
    const aggregate = expectDefined(
      bindSessionPendingInputSources([first, second], message("atomic-c")),
      "Expected collected input custody",
    );
    const combined = expectDefined(
      readUserTurnDelegatedInputPolicy(aggregate.message),
      "Expected collected input policy",
    );
    expect(combined.clauses).toEqual([...firstPolicy.clauses, ...secondPolicy.clauses]);
    const allows = createInheritedToolPolicyMatcher({ policy: combined });
    expect(allows({ name: "read" })).toBe(true);
    expect(allows({ name: "exec" })).toBe(false);
    expect(
      readUserTurnDelegatedInputPolicy(readSessionPendingInput(scope(), first.inputId)?.message),
    ).toEqual(firstPolicy);
    receipts.push(aggregate);
    const before = await loadTranscriptEvents(scope());
    database().db.exec(
      "CREATE TRIGGER reject_collect_consume BEFORE UPDATE OF consumed_event_id ON session_pending_inputs WHEN OLD.run_id = 'atomic-b' BEGIN SELECT RAISE(ABORT, 'collect consume failed'); END",
    );
    await expect(promote(aggregate)).rejects.toThrow("collect consume failed");
    expect(await loadTranscriptEvents(scope())).toEqual(before);
    expect(listSessionPendingInputs(scope()).total).toBe(2);
    expect(listSessionPendingInputReceipts(scope(), { runIds: ["atomic-a", "atomic-b"] })).toEqual([
      { runId: "atomic-a", state: "pending" },
      { runId: "atomic-b", state: "pending" },
    ]);
    database().db.exec("DROP TRIGGER reject_collect_consume");
    expect(await promote(aggregate)).toMatchObject({
      appended: true,
      messageId: aggregate.inputId,
    });
    expect(listSessionPendingInputs(scope()).total).toBe(0);
  });
}
