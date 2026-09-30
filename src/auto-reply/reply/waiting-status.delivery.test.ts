import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { SubagentRegistryWriteError } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import type * as SubagentRegistry from "../../agents/subagents/registry/subagent-registry.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { markAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import type { PendingContinuationSettlement } from "./get-reply.types.js";
import { createReplyOperation, retainReplyOperationUntilComplete } from "./reply-run-registry.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";
vi.mock("../../agents/subagents/registry/subagent-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SubagentRegistry>()),
  settleRequesterAfterSessionSpawns: settleRequester,
}));
vi.mock("../../agents/live-model-switch.js", () => ({
  consolidateLiveModelSwitchAfterRun: vi.fn(async () => {}),
}));

const settleRequester = vi.hoisted(() =>
  vi.fn<typeof SubagentRegistry.settleRequesterAfterSessionSpawns>(async () => true),
);

const runId = "waiting-progress-run";

function createContext(): FinalizeReplyAgentRunInput {
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
  retainReplyOperationUntilComplete(replyOperation);
  onTestFinished(() => replyOperation.complete());
  return {
    activeIsNewSession: false,
    activeSessionEntry: undefined,
    activeSessionStore: undefined,
    blockReplyPipeline: null,
    blockStreamingEnabled: false,
    cfg: {},
    commandBody: followupRun.prompt,
    defaultModel: followupRun.run.model,
    followupRun,
    isHeartbeat: false,
    pendingToolTasks: new Set(),
    preflightCompactionApplied: false,
    queueKey: sessionKey,
    replyMediaContext: { normalizePayload: async (payload) => payload },
    replyOperation,
    replyRouteThreadId: undefined,
    replyToChannel: "discord",
    replyToMode: "off",
    resolvedBlockStreamingBreak: "message_end",
    resolvedQueue: { mode: "followup" },
    resolvedVerboseLevel: "off",
    returnWithQueuedFollowupDrain: (value) => value,
    runFollowupTurn: async () => {},
    execution: {
      kind: "settled",
      status: "ok",
      result: {
        payloads: [],
        meta: { durationMs: 0, yielded: true },
        acceptedSessionSpawns: [
          { runId: "index-worker-run", childSessionKey: "agent:main:subagent:index-worker" },
        ],
      },
      resolved: { provider: followupRun.run.provider, model: followupRun.run.model },
      fallback: { exhausted: false, attempts: [] },
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
    },
    runId,
    runStartedAt: Date.now(),
    sessionCtx: { Provider: "discord", Surface: "discord", To: "channel:C1" },
    sessionKey,
    shouldInjectGroupIntro: false,
    typingSignals: createTypingSignaler({
      typing: createMockTypingController(),
      mode: "never",
      isHeartbeat: false,
    }),
  };
}

async function prepare(lane: "ordinary" | "queued", context: FinalizeReplyAgentRunInput) {
  const accounting = await accountAgentTurn(context);
  if (lane === "ordinary") {
    const prepared = await prepareReplyAgentPayloads({ context, accounting });
    return prepared.kind === "continue"
      ? prepared.guardedReplyPayloads
      : prepared.value
        ? [prepared.value]
        : [];
  }
  const turn: AdmittedFollowupTurn = {
    runId,
    queued: context.followupRun,
    operation: context.replyOperation,
    config: context.cfg,
    session: {
      kind: "session",
      key: expectDefined(context.followupRun.run.sessionKey, "queued requester session"),
      current: () => undefined,
      publish: () => undefined,
      adopt: () => undefined,
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  };
  const decision = await resolveFollowupDeliveryDecision({
    turn,
    execution: { runId, outcome: context.execution },
    accounting,
    opts: { ...context.opts, isHeartbeat: context.isHeartbeat },
  });
  return decision.kind === "deliver" ? decision.payloads : [];
}

beforeEach(() => {
  settleRequester.mockReset().mockImplementation(async (params) => {
    params.assertCurrent?.();
    await Promise.resolve();
    params.assertCurrent?.();
    return true;
  });
});

it("delivers an ordinary terminal failure", async () => {
  const context = createContext();
  context.execution.result.acceptedSessionSpawns = undefined;
  context.execution.result.meta = { durationMs: 0 };
  context.execution = {
    ...context.execution,
    status: "failed",
    terminalFailurePayload: markAgentRunFailureReplyPayload({ text: "Terminal failure" }),
  };
  const payloads = await prepare("ordinary", context);
  expect(payloads.map((payload) => payload.text)).toEqual(["Terminal failure"]);
  expect(payloads[0]?.isError).toBe(true);
});

describe.each(["ordinary", "queued"] as const)("%s waiting status delivery", (lane) => {
  it.each(["explicit acknowledgment", "visible final"])(
    "preserves %s precedence",
    async (precedence) => {
      const context = createContext();
      const onPendingContinuation = vi.fn<(settlement?: PendingContinuationSettlement) => void>();
      context.opts = { onPendingContinuation };
      const selected = { text: `${precedence} selected` };
      if (precedence === "explicit acknowledgment") {
        context.execution.result.meta.yieldAcknowledgment = ` ${selected.text} `;
        context.execution.result.payloads = [{ text: "Private plan", isReasoning: true }];
        if (lane === "queued") {
          context.followupRun.originatingChatType = "group";
          context.followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
          context.execution.result.payloads.push({ text: "Private partial output" });
        }
      } else {
        context.execution.result.meta.yieldAcknowledgment = "Still waiting.";
        context.execution.result.payloads = [selected];
      }
      const payloads = await prepare(lane, context);
      expect(payloads.map((payload) => payload.text)).toEqual([selected.text]);
      if (precedence === "explicit acknowledgment") {
        expect(getReplyPayloadMetadata(payloads[0] ?? {})).toMatchObject({
          continuationStatus: true,
          deliverDespiteSourceReplySuppression: true,
        });
        if (lane === "ordinary") {
          expect(onPendingContinuation.mock.calls).toEqual([[]]);
        }
      }
    },
  );

  it.each(["optional turn", "delivered message"])(
    "does not deliver a waiting status for a %s",
    async (suppression) => {
      const context = createContext();
      if (suppression === "optional turn") {
        context.followupRun.run.terminalReplyExpectation = "optional";
      } else {
        context.execution.result.didDeliverSourceReplyViaMessageTool = true;
      }
      expect(await prepare(lane, context)).toEqual([]);
    },
  );
});

it.each([true, false])(
  "settles an implicit continuation once after delivery=%s",
  async (delivered) => {
    const context = createContext();
    context.execution.result.meta = {
      durationMs: 0,
      continuationPending: true,
      yieldAcknowledgment: " ",
    };
    const onPendingContinuation = vi.fn<(settlement?: PendingContinuationSettlement) => void>();
    context.opts = { onPendingContinuation };
    context.execution.directBlockDeliveries = [
      { payload: { text: "Unpublished draft" }, outcome: "delivered-not-visible", pending: true },
    ];

    const payloads = await prepare("ordinary", context);
    expect(payloads).toHaveLength(1);
    expect(getReplyPayloadMetadata(payloads[0] ?? {})).toMatchObject({
      continuationStatus: true,
      deliverDespiteSourceReplySuppression: true,
    });

    expect(settleRequester).not.toHaveBeenCalled();
    expect(onPendingContinuation).toHaveBeenCalledOnce();
    const settlement = onPendingContinuation.mock.calls[0]?.[0];
    expect(settlement).toBeDefined();
    await Promise.all([settlement?.settle(delivered), settlement?.settle(!delivered)]);
    expect(settleRequester).toHaveBeenCalledOnce();
    expect(settleRequester.mock.calls[0]?.[0]).toMatchObject({
      requesterYielded: delivered,
    });
    await settlement?.settle(!delivered);
    expect(settleRequester).toHaveBeenCalledOnce();
  },
);

it.each(["refusal", "persistence failure"] as const)(
  "releases an implicit continuation after settlement %s",
  async (failure) => {
    const context = createContext();
    context.execution.result.meta = { durationMs: 0, continuationPending: true };
    const onPendingContinuation = vi.fn<(settlement?: PendingContinuationSettlement) => void>();
    context.opts = { onPendingContinuation };
    await prepare("ordinary", context);
    const settlement = expectDefined(
      onPendingContinuation.mock.calls[0]?.[0],
      "implicit continuation settlement",
    );
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
    expect(settleRequester).toHaveBeenCalledOnce();

    await settlement.settle(false);
    expect(settleRequester.mock.calls.map(([params]) => params.requesterYielded)).toEqual([
      true,
      false,
    ]);
    await settlement.settle(true);
    expect(settleRequester).toHaveBeenCalledTimes(2);
  },
);

it.each(["committed", "unknown"] as const)(
  "retains the %s settlement outcome when finalization requests non-yielded compensation",
  async (outcome) => {
    const context = createContext();
    context.execution.result.meta = { durationMs: 0, continuationPending: true };
    const pending = vi.fn<(settlement?: PendingContinuationSettlement) => void>();
    context.opts = { onPendingContinuation: pending };
    await prepare("ordinary", context);
    const settlement = expectDefined(pending.mock.calls[0]?.[0], "outbox handoff");
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
    expect(settleRequester).toHaveBeenCalledOnce();
  },
);

it.each(["replacement", "rebound key", "rebound session", "retained abort"] as const)(
  "settles the captured outbox after %s only while its original reply owner remains current",
  async (change) => {
    const context = createContext();
    context.execution.result.meta = { durationMs: 0, continuationPending: true };
    const pending = vi.fn<(settlement?: PendingContinuationSettlement) => void>();
    context.opts = { onPendingContinuation: pending };
    await prepare("ordinary", context);
    const settlement = expectDefined(pending.mock.calls[0]?.[0], "outbox handoff");
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
      expect(settleRequester).toHaveBeenCalledOnce();
      expect(settleRequester.mock.calls[0]?.[0].requesterYielded).toBe(false);
    } else {
      await expect(settlement.settle(false)).rejects.toThrow("original reply operation");
      expect(settleRequester).not.toHaveBeenCalled();
    }
  },
);
