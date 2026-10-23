import { expect, it, vi } from "vitest";
import {
  cancelSubagentCompletionToolHandoff,
  consumeSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
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
