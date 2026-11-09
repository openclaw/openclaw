import { expect, it, vi } from "vitest";
import { assertOperatorModelAllowed } from "../agents/admitted-run-context.js";
import {
  captureRequesterModelPolicySnapshot,
  prepareOperatorModelPolicy,
  restoreRequesterModelPolicySnapshot,
} from "../agents/operator-model-policy.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  cancelSubagentCompletionToolHandoff,
  consumeSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
  readSubagentCompletionRequesterModelPolicy,
  isCurrentSubagentCompletionRequester,
} from "./subagent-completion-tool-handoff.js";

const identity = {
  sourceSessionKey: "agent:main:subagent:child",
  sourceSessionId: "child-session",
  targetSessionKey: "agent:main:main",
  targetSessionId: "requester-session",
} as const;
const registration = { ...identity, idempotencyKey: "announce-1" };

function consume(handoffId: string | undefined, overrides: Record<string, unknown> = {}) {
  return consumeSubagentCompletionToolHandoff({
    handoffId,
    sourceTool: "subagent_announce",
    ...registration,
    provider: "openai",
    model: "glm-4.5",
    ...overrides,
  });
}

function registerBatch(sourceSessionKeys: string[], isCurrent = () => true) {
  return registerSubagentCompletionToolHandoff({
    ...registration,
    settleBatch: { sourceSessionKeys, isCurrent },
  });
}

it("consumes the exact capability once and binds it to the admitted route", () => {
  const handoffId = registerSubagentCompletionToolHandoff(registration);
  expect(consume(handoffId)).toEqual({
    kind: "subagent-completion",
    ...identity,
    provider: "openai",
    model: "glm-4.5",
  });
  expect(consume(handoffId)).toBeUndefined();
});

it.each([
  ["source session", { sourceSessionKey: "agent:main:subagent:forged" }],
  ["source run", { sourceSessionId: "forged-child-session" }],
  ["target session", { targetSessionKey: "agent:main:other" }],
  ["target run", { targetSessionId: "replaced-requester-session" }],
  ["idempotency key", { idempotencyKey: "announce-forged" }],
  ["source tool", { sourceTool: "subagent_settle" }],
])("rejects a mismatched %s without burning the valid capability", (_name, overrides) => {
  const handoffId = registerSubagentCompletionToolHandoff(registration);
  expect(consume(handoffId, overrides)).toBeUndefined();
  expect(consume(handoffId)).toBeDefined();
});

it("rejects missing and forged capability ids", () => {
  expect(consume(undefined)).toBeUndefined();
  expect(consume("forged")).toBeUndefined();
});

it("revalidates the settle owner's authority before consuming a capability", () => {
  let current = true;
  const handoffId = registerBatch([registration.sourceSessionKey], () => current);
  expect(handoffId).toBeDefined();
  expect(consume(handoffId)).toBeUndefined();
  current = false;
  expect(consume(handoffId, { sourceTool: "subagent_settle" })).toBeUndefined();
  expect(cancelSubagentCompletionToolHandoff(handoffId)).toBe(true);
});

it("binds an accepted replay source only within the registered settle cohort", () => {
  const acceptedSource = "agent:main:subagent:sibling";
  const handoffId = registerBatch([registration.sourceSessionKey, acceptedSource]);
  expect(
    consume(handoffId, {
      sourceTool: "subagent_settle",
      sourceSessionKey: "agent:main:subagent:outside-batch",
    }),
  ).toBeUndefined();
  const accepted = { sourceTool: "subagent_settle", sourceSessionKey: acceptedSource };
  expect(consume(handoffId, accepted)?.sourceSessionKey).toBe(acceptedSource);
  expect(consume(handoffId, accepted)).toBeUndefined();
});

it("expires capabilities and removes cancelled capabilities", () => {
  const expiredId = registerSubagentCompletionToolHandoff({ ...registration, nowMs: 1_000 });
  using _ = vi.spyOn(Date, "now").mockReturnValue(301_001);
  expect(consume(expiredId)).toBeUndefined();

  const cancelledId = registerSubagentCompletionToolHandoff(registration);
  expect(cancelSubagentCompletionToolHandoff(cancelledId)).toBe(true);
  expect(consume(cancelledId)).toBeUndefined();
});

it("keeps legacy result handoff custody separate from unknown model restrictions", () => {
  const handoffId = registerSubagentCompletionToolHandoff(registration);
  const target = { ...registration, handoffId };
  expect(readSubagentCompletionRequesterModelPolicy(target)).toEqual({ kind: "unknown" });
  expect(isCurrentSubagentCompletionRequester(target)).toBe(true);
  expect(isCurrentSubagentCompletionRequester({ ...target, targetSessionId: "replacement" })).toBe(
    false,
  );
  expect(isCurrentSubagentCompletionRequester({ ...target, idempotencyKey: "other" })).toBe(false);
  expect(consume(handoffId)).toMatchObject({ kind: "subagent-completion" });
  expect(isCurrentSubagentCompletionRequester(target)).toBe(false);
});

it("requires the completion batch's current relation to qualify a System continuation", () => {
  const isCurrent = vi.fn(() => true);
  const handoffId = registerSubagentCompletionToolHandoff({
    ...registration,
    settleBatch: { sourceSessionKeys: [identity.sourceSessionKey], isCurrent },
  });
  const target = { ...registration, handoffId };
  expect(isCurrentSubagentCompletionRequester(target)).toBe(true);
  isCurrent.mockReturnValue(false);
  expect(isCurrentSubagentCompletionRequester(target)).toBe(false);
  cancelSubagentCompletionToolHandoff(handoffId);
});

it.each([false, true])(
  "keeps the completed result's ceiling after a new followup (batch=%s)",
  (batch) => {
    const ceiling = captureRequesterModelPolicySnapshot(
      prepareOperatorModelPolicy({
        cfg: {
          agents: {
            defaults: {
              model: "custom/allowed",
              models: { "custom/allowed": {}, "custom/forbidden": {} },
            },
          },
        },
        policy: { allow: ["custom/allowed"] },
        manifestPlugins: [],
      }),
    );
    const completed = createSubagentRunRecord({
      runId: "policy-completed-result",
      childSessionKey: identity.sourceSessionKey,
      requesterSessionKey: identity.targetSessionKey,
      completionRequesterSessionId: identity.targetSessionId,
      requesterModelPolicySnapshot: ceiling,
      generation: 1,
      createdAt: 1,
      endedAt: 2,
      outcome: { status: "ok" },
    });
    const followup = createSubagentRunRecord({
      ...completed,
      runId: "policy-new-followup",
      requesterModelPolicySnapshot: { kind: "unbounded" },
      generation: 2,
      createdAt: 3,
    });
    subagentRuns.set(completed.runId, completed);
    subagentRuns.set(followup.runId, followup);
    const handoffId = registerSubagentCompletionToolHandoff({
      ...registration,
      sourceRunIds: [completed.runId],
      ...(batch
        ? { settleBatch: { sourceSessionKeys: [identity.sourceSessionKey], isCurrent: () => true } }
        : {}),
    });
    try {
      const policy = restoreRequesterModelPolicySnapshot(
        readSubagentCompletionRequesterModelPolicy({ ...registration, handoffId }),
      );
      expect(() =>
        assertOperatorModelAllowed(undefined, { provider: "custom", model: "allowed" }, policy),
      ).not.toThrow();
      expect(() =>
        assertOperatorModelAllowed(undefined, { provider: "custom", model: "forbidden" }, policy),
      ).toThrow("cannot use this model");
    } finally {
      cancelSubagentCompletionToolHandoff(handoffId);
      subagentRuns.delete(completed.runId);
      subagentRuns.delete(followup.runId);
    }
  },
);
