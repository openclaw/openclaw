import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { SubagentRegistryWriteError } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import type * as SubagentRegistry from "../../agents/subagents/registry/subagent-registry.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { markAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { createTestFinalizationContext } from "./agent-runner-result-accounting.persistence.test-support.js";
import { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import { createTurn } from "./followup-delivery.test-helpers.js";
import type { PendingContinuationSettlement } from "./get-reply.types.js";
import { createMockFollowupRun } from "./test-helpers.js";
vi.mock("../../agents/subagents/registry/subagent-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SubagentRegistry>()),
  settleRequesterAfterSessionSpawns: settleRequester,
}));
const settleRequester = vi.hoisted(() =>
  vi.fn<typeof SubagentRegistry.settleRequesterAfterSessionSpawns>(async () => true),
);

const runId = "waiting-progress-run";
type ResultMeta = FinalizeReplyAgentRunInput["execution"]["result"]["meta"];
let context: FinalizeReplyAgentRunInput;
let result: FinalizeReplyAgentRunInput["execution"]["result"];
const pending = vi.fn<(settlement?: PendingContinuationSettlement) => void>();

function createContext(meta: Partial<ResultMeta> = { yielded: true }): FinalizeReplyAgentRunInput {
  const sessionKey = "agent:main:waiting-progress";
  const followupRun = createMockFollowupRun({
    originatingChannel: "discord",
    run: { sessionKey, messageProvider: "discord", terminalReplyExpectation: "required" },
  });
  const replyOperation = createReplyOperation({
    sessionKey,
    sessionId: followupRun.run.sessionId,
    resetTriggered: false,
  });
  onTestFinished(() => replyOperation.complete());
  const base = createTestFinalizationContext(followupRun, replyOperation);
  return {
    ...base,
    activeSessionStore: undefined,
    cfg: {},
    replyToChannel: "discord",
    execution: {
      ...base.execution,
      result: {
        payloads: [],
        meta: { durationMs: 0, ...meta },
        acceptedSessionSpawns: [
          {
            runId: "child",
            childSessionKey: "agent:main:subagent:c",
            expectsCompletionMessage: true,
          },
        ],
      },
    },
    runId,
    sessionCtx: { Provider: "discord", Surface: "discord", To: "channel:C1" },
  };
}

function captureContinuation() {
  context.opts = { onPendingContinuation: pending };
}

function expectYielded(...values: boolean[]) {
  expect(settleRequester.mock.calls.map(([params]) => params.requesterYielded)).toEqual(values);
}

async function prepareContinuation(meta: Partial<ResultMeta> = { continuationPending: true }) {
  result.meta = { durationMs: 0, ...meta };
  captureContinuation();
  expect(await prepare()).toEqual([]);
  return expectDefined(pending.mock.calls[0]?.[0], "continuation settlement");
}

async function prepare(lane: "ordinary" | "queued" = "ordinary") {
  const accounting = await accountAgentTurn(context);
  if (lane === "ordinary") {
    const prepared = await prepareReplyAgentPayloads({ context, accounting });
    return prepared.kind === "continue"
      ? prepared.guardedReplyPayloads
      : prepared.value
        ? [prepared.value]
        : [];
  }
  const turn = createTurn({
    runId,
    queued: context.followupRun,
    operation: context.replyOperation,
    config: context.cfg,
    session: {
      kind: "session",
      key: expectDefined(context.followupRun.run.sessionKey, "queued requester session"),
      current: () => undefined,
      publish: () => undefined,
    },
  });
  const decision = await resolveFollowupDeliveryDecision({
    turn,
    execution: { runId, outcome: context.execution },
    accounting,
    opts: { ...context.opts, isHeartbeat: context.isHeartbeat },
  });
  return decision.kind === "deliver" ? decision.payloads : [];
}

beforeEach(() => {
  context = createContext();
  result = context.execution.result;
  pending.mockReset();
  settleRequester.mockReset().mockImplementation(async (params) => {
    params.assertCurrent?.();
    await Promise.resolve();
    params.assertCurrent?.();
    return true;
  });
});

it("delivers an ordinary terminal failure", async () => {
  result.meta = { durationMs: 0 };
  result.acceptedSessionSpawns = undefined;
  context.execution = {
    ...context.execution,
    status: "failed",
    terminalFailurePayload: markAgentRunFailureReplyPayload({ text: "Terminal failure" }),
  };
  expect(await prepare()).toMatchObject([{ text: "Terminal failure", isError: true }]);
});

const blockedText = "Blocked by before_agent_run policy";
it.each([
  ["silent", { terminalReply: { disposition: "silent" } }, true],
  ["message-tool sentinel", { finalAssistantRawText: "NO_REPLY" }, true],
  [
    "hook block",
    {
      livenessState: "blocked",
      finalAssistantRawText: blockedText,
      error: { kind: "hook_block", message: blockedText },
    },
    false,
  ],
] as const)("captures only model text: %s", async (kind, meta, optional) => {
  result.meta = { durationMs: 0, ...meta };
  const onRawLlmResponse = vi.fn();
  context.opts = { onRawLlmResponse };
  if (optional) {
    context.followupRun.run.terminalReplyExpectation = "optional";
    result.acceptedSessionSpawns = undefined;
  }
  if (kind === "message-tool sentinel") {
    result.messagingToolSourceReplyPayloads = [
      { text: "delivered by message tool", sourceReplyFinal: true },
    ];
  }
  const payloads = await prepare();
  if (optional) {
    expect(payloads).toEqual([]);
  }
  expect(onRawLlmResponse.mock.calls).toEqual(
    kind === "message-tool sentinel" ? [["NO_REPLY"]] : [],
  );
});

describe.each(["ordinary", "queued"] as const)("%s waiting status delivery", (lane) => {
  it.each(["explicit acknowledgment", "visible final", "optional turn", "delivered message"])(
    "selects waiting status for %s",
    async (selection) => {
      if (selection === "explicit acknowledgment" || selection === "visible final") {
        captureContinuation();
      }
      const selected = { text: `${selection} selected` };
      if (selection === "optional turn") {
        context.followupRun.run.terminalReplyExpectation = "optional";
      } else if (selection === "delivered message") {
        result.didDeliverSourceReplyViaMessageTool = true;
      } else if (selection === "explicit acknowledgment") {
        result.meta.yieldAcknowledgment = ` ${selected.text} `;
        result.payloads = [{ text: "Private plan", isReasoning: true }];
        if (lane === "queued") {
          context.followupRun.originatingChatType = "group";
          context.followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
          result.payloads.push({ text: "Private partial output" });
        }
      } else {
        result.meta.yieldAcknowledgment = "Still waiting.";
        result.payloads = [selected];
      }
      const payloads = await prepare(lane);
      if (selection === "optional turn" || selection === "delivered message") {
        expect(payloads).toEqual([]);
        return;
      }
      expect(payloads.map((payload) => payload.text)).toEqual([selected.text]);
      if (selection === "explicit acknowledgment") {
        expect(getReplyPayloadMetadata(payloads[0] ?? {})).toMatchObject({
          continuationStatus: true,
          deliverDespiteSourceReplySuppression: true,
        });
        if (lane === "ordinary") {
          expect(pending.mock.calls).toEqual([[]]);
        }
      }
    },
  );
});

it.each([true, false])("settles once after delivery=%s", async (delivered) => {
  result.meta = { durationMs: 0, continuationPending: true, yieldAcknowledgment: " " };
  captureContinuation();
  context.execution.directBlockDeliveries = [
    { payload: { text: "Unpublished draft" }, outcome: "delivered-not-visible", pending: true },
  ];

  expect(await prepare()).toEqual([]);

  expectYielded();
  expect(pending).toHaveBeenCalledOnce();
  const settlement = expectDefined(pending.mock.calls[0]?.[0], "continuation settlement");
  await Promise.all([settlement.settle(delivered), settlement.settle(!delivered)]);
  expectYielded(delivered);
  await settlement.settle(!delivered);
  expectYielded(delivered);
});

it.each(["ordinary", "queued"] as const)(
  "keeps unauthored %s result-required status silent",
  async (lane) => {
    result.meta = { durationMs: 0, continuationPending: true };
    context.followupRun.run.terminalReplyExpectation = "result-required";

    expect(await prepare(lane)).toEqual([]);
  },
);

it.each(["delivered", "cancelled", "aborted"] as const)(
  "settles silent children after %s",
  async (outcome) => {
    const settlement = await prepareContinuation({
      continuationPending: true,
      finalAssistantRawText: "NO_REPLY",
      terminalReply: { disposition: "silent" },
    });
    if (outcome === "aborted") {
      expect(context.replyOperation.abortByUser()).toBe(true);
    }
    await settlement.settle(outcome !== "cancelled");
    expectYielded(outcome === "delivered");
  },
);

it.each(["refusal", "persistence failure"] as const)(
  "releases continuation after %s",
  async (failure) => {
    const settlement = await prepareContinuation();
    settleRequester.mockImplementationOnce(async () => {
      if (failure === "persistence failure") {
        throw new Error("native settlement persistence failed");
      }
      return false;
    });

    await expect(Promise.all([settlement.settle(true), settlement.settle(true)])).rejects.toThrow(
      failure === "persistence failure"
        ? "native settlement persistence failed"
        : "accepted continuation children could not transfer terminal delivery",
    );
    expectYielded(true);

    await settlement.settle(false);
    expectYielded(true, false);
    await settlement.settle(true);
    expectYielded(true, false);
  },
);

it.each(["committed", "unknown"] as const)(
  "retains %s settlement through compensation",
  async (outcome) => {
    const settlement = await prepareContinuation();
    const failure = new SubagentRegistryWriteError(
      outcome,
      new Error("native outcome retained"),
      outcome === "committed" ? "published" : undefined,
    );
    settleRequester.mockRejectedValueOnce(failure);
    const first = settlement.settle(true);
    await expect(first).rejects.toBe(failure);
    const compensation = settlement.settle(false);
    expect(compensation).toBe(first);
    await expect(compensation).rejects.toBe(failure);
    expectYielded(true);
  },
);

it.each(["replacement", "rebound key", "rebound session", "retained abort"] as const)(
  "fences captured outbox settlement after %s",
  async (change) => {
    const settlement = await prepareContinuation();
    const operation = context.replyOperation;
    if (change === "replacement") {
      operation.complete();
      const replacement = createReplyOperation({
        sessionKey: operation.key,
        sessionId: operation.sessionId,
        resetTriggered: false,
      });
      onTestFinished(() => replacement.complete());
    } else if (change === "rebound key") {
      operation.updateSessionKey("agent:main:rebound-outbox");
    } else if (change === "rebound session") {
      operation.updateSessionId("rebound-outbox-session");
    } else {
      expect(operation.abortByUser()).toBe(true);
    }
    if (change === "retained abort") {
      await settlement.settle(false);
      expectYielded(false);
    } else {
      await expect(settlement.settle(false)).rejects.toThrow("original reply operation");
      expectYielded();
    }
  },
);
