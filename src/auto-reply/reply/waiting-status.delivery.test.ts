import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SubagentRegistry from "../../agents/subagents/registry/subagent-registry.js";
import type { ProgressContinuationReceipt } from "../../channels/progress-continuation.js";
import type * as ProgressRequester from "../../tasks/task-progress-requester.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { markAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import type { PendingContinuationSettlement } from "./get-reply.types.js";
import {
  createMockFollowupRun,
  createMockReplyOperation,
  createMockTypingController,
} from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

const { createContinuation, settleRequester } = vi.hoisted(() => ({
  createContinuation: vi.fn<typeof ProgressRequester.createTaskProgressContinuation>(),
  settleRequester: vi.fn<typeof SubagentRegistry.settleRequesterAfterSessionSpawns>(() => true),
}));

vi.mock("../../tasks/task-progress-requester.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProgressRequester>()),
  createTaskProgressContinuation: createContinuation,
}));
vi.mock("../../agents/subagents/registry/subagent-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SubagentRegistry>()),
  settleRequesterAfterSessionSpawns: settleRequester,
}));
vi.mock("../../agents/live-model-switch.js", () => ({
  consolidateLiveModelSwitchAfterRun: vi.fn(async () => {}),
}));

const runId = "waiting-progress-run";
const receipt: ProgressContinuationReceipt = {
  channel: "discord",
  to: "channel:C1",
  messageId: "progress-card",
  text: "IndexWorker is working.",
  snapshot: { lines: ["IndexWorker is working."] },
};

function createContext(): FinalizeReplyAgentRunInput {
  const sessionKey = "agent:main:waiting-progress";
  const followupRun = createMockFollowupRun({
    originatingChannel: "discord",
    run: { sessionKey, messageProvider: "discord", terminalReplyExpectation: "required" },
  });
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
    replyOperation: createMockReplyOperation().replyOperation,
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
  settleRequester.mockReset().mockReturnValue(true);
  createContinuation.mockReset().mockImplementation(async (params) => {
    let open = true;
    return {
      adopt: async () => {
        if (!open) {
          return false;
        }
        params.onAdopted?.({ operationId: "progress-operation" });
        return true;
      },
      close: () => {
        open = false;
      },
    };
  });
});

describe.each(["ordinary", "queued"] as const)("%s waiting status delivery", (lane) => {
  it.each(["explicit acknowledgment", "visible final", "terminal failure"])(
    "preserves %s precedence",
    async (precedence) => {
      const context = createContext();
      const onPendingContinuation = vi.fn<(settlement?: PendingContinuationSettlement) => void>();
      context.opts = { onPendingContinuation };
      const selected: ReplyPayload = { text: `${precedence} selected` };
      if (precedence === "explicit acknowledgment") {
        context.execution.result.meta.yieldAcknowledgment = ` ${selected.text} `;
        context.execution.result.payloads = [{ text: "Private plan", isReasoning: true }];
        if (lane === "queued") {
          context.followupRun.originatingChatType = "group";
          context.followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
          context.execution.result.payloads.push({ text: "Private partial output" });
        }
      } else if (precedence === "visible final") {
        context.execution.result.meta.yieldAcknowledgment = "Still waiting.";
        context.execution.result.payloads = [selected];
      } else {
        context.execution.result.acceptedSessionSpawns = undefined;
        context.execution.result.meta = { durationMs: 0 };
        context.execution = {
          ...context.execution,
          status: "failed",
          terminalFailurePayload: markAgentRunFailureReplyPayload(selected),
        };
      }
      const payloads = await prepare(lane, context);
      expect(payloads.map((payload) => payload.text)).toEqual([selected.text]);
      if (selected.isError) {
        expect(payloads[0]?.isError).toBe(true);
      }
      if (precedence === "explicit acknowledgment") {
        expect(getReplyPayloadMetadata(payloads[0] ?? {})).toMatchObject({
          continuationStatus: true,
          deliverDespiteSourceReplySuppression: true,
        });
        if (lane === "ordinary") {
          expect(onPendingContinuation.mock.calls).toEqual([[]]);
        }
      }
      if (precedence !== "explicit acknowledgment") {
        expect(createContinuation).not.toHaveBeenCalled();
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
      expect(createContinuation).not.toHaveBeenCalled();
    },
  );

  it("does not offer adoption for a yield without accepted children", async () => {
    const context = createContext();
    context.execution.result.acceptedSessionSpawns = [];
    const payloads = await prepare(lane, context);
    expect(getReplyPayloadMetadata(payloads[0] ?? {})?.continuationStatus).toBe(true);
    expect(getReplyPayloadMetadata(payloads[0] ?? {})?.progressContinuation?.adopt).toBeUndefined();
    expect(createContinuation).not.toHaveBeenCalled();
  });
});

it.each([
  { delivered: true, adopted: false },
  { delivered: false, adopted: false },
  { delivered: true, adopted: true },
  { delivered: false, adopted: true },
])(
  "settles an implicit continuation once after delivery=$delivered adoption=$adopted",
  async ({ delivered, adopted }) => {
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
    const adopt = getReplyPayloadMetadata(payloads[0] ?? {})?.progressContinuation?.adopt;
    if (adopted) {
      await expect(adopt?.(receipt)).resolves.toBe(true);
    }
    expect(settleRequester).not.toHaveBeenCalled();
    expect(onPendingContinuation).toHaveBeenCalledOnce();
    const settlement = onPendingContinuation.mock.calls[0]?.[0];
    expect(settlement).toBeDefined();
    await settlement?.settle(delivered);
    expect(settleRequester).toHaveBeenCalledOnce();
    expect(settleRequester.mock.calls[0]?.[0]).toMatchObject({
      requesterYielded: delivered || adopted,
      ...(adopted ? { progressPresentation: { operationId: "progress-operation" } } : {}),
    });
    await expect(adopt?.(receipt)).resolves.toBe(false);
  },
);

it("releases child delivery if a receipt-backed handoff fails after an ambiguous send", async () => {
  const context = createContext();
  context.execution.result.meta = { durationMs: 0, continuationPending: true };
  const onPendingContinuation = vi.fn<(settlement?: PendingContinuationSettlement) => void>();
  context.opts = { onPendingContinuation };
  const payloads = await prepare("ordinary", context);
  const adopt = getReplyPayloadMetadata(payloads[0] ?? {})?.progressContinuation?.adopt;
  await expect(adopt?.(receipt)).resolves.toBe(true);
  settleRequester.mockReturnValueOnce(false);

  await expect(onPendingContinuation.mock.calls[0]?.[0]?.settle(false)).rejects.toThrow(
    "accepted continuation children could not transfer terminal delivery",
  );
  expect(
    settleRequester.mock.calls.map(([params]) => ({
      yielded: params.requesterYielded,
      presentation: params.progressPresentation,
    })),
  ).toEqual([
    { yielded: true, presentation: { operationId: "progress-operation" } },
    { yielded: false, presentation: undefined },
  ]);
  await expect(adopt?.(receipt)).resolves.toBe(false);
});
