// Tests follow-up reply delivery and route preservation.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { createChatSendLateFollowupDisposition } from "../../gateway/server-methods/chat-send-late-followup.js";
import type * as ProviderRuntime from "../../plugins/provider-runtime.js";
import { retireSessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import {
  createAccounting,
  createDefaults,
  createSettledExecution,
  createTurn,
} from "./followup-delivery.test-helpers.js";
import { scheduleFollowupDrain } from "./queue/drain.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import type { FollowupRun } from "./queue/types.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";
import { createMockReplyOperation } from "./test-helpers.js";

const deliveryState = vi.hoisted(() => ({
  followupRoute: undefined as { route: "dispatcher" | "origin" | "drop" } | undefined,
  routeReply: vi.fn(),
  runtimeError: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  enqueueFollowupRun: (...args: unknown[]) => deliveryState.enqueue(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
  getLoadedChannelPlugin: () => undefined,
}));

vi.mock("../../plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderRuntime>()),
  resolveProviderFollowupFallbackRoute: () => deliveryState.followupRoute,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: (...args: unknown[]) => deliveryState.runtimeError(...args) },
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) => channel === "discord" || channel === "slack",
  routeReply: (...args: unknown[]) => deliveryState.routeReply(...args),
}));

type DecisionParams = Parameters<typeof resolveFollowupDeliveryDecision>[0];
function decide(
  turn = createTurn(),
  execution: DecisionParams["execution"] = createSettledExecution(),
  accounting: DecisionParams["accounting"] = createAccounting(),
  opts?: DecisionParams["opts"],
) {
  return resolveFollowupDeliveryDecision({ turn, execution, accounting, opts });
}

function deliverDecision({
  turn = createTurn(),
  ...params
}: Pick<Parameters<typeof deliverFollowupDecision>[0], "decision"> &
  Partial<Parameters<typeof deliverFollowupDecision>[0]>) {
  return deliverFollowupDecision({
    defaults: createDefaults(vi.fn(async () => {})),
    runFollowup: vi.fn(async () => {}),
    turn,
    runId: turn.runId,
    ...params,
  });
}

const missingReply = {
  text: "No answer was returned. Ask again if you still need one.",
  isError: true,
  isStatusNotice: true,
};
const silent = { kind: "suppress", reason: "silent" };

describe("resolveFollowupDeliveryDecision", () => {
  const sourceReplyTarget = {
    tool: "message",
    provider: "discord",
    to: "channel:C1",
    text: "Still working",
  };
  const progressTarget = { ...sourceReplyTarget, sourceReplyFinal: false };
  const finalTarget = { ...sourceReplyTarget, sourceReplyFinal: true };

  it.each([
    { state: undefined, routed: true, delivered: true },
    { state: "missing", routed: true, delivered: false },
    { state: undefined, routed: false, delivered: false },
  ] as const)(
    "requires current-source evidence before suppressing a queued duplicate: $state/$routed",
    async ({ state, routed, delivered }) => {
      const execution = createSettledExecution("Completed.");
      execution.outcome.result.sourceReplyDeliveryState = state;
      execution.outcome.result.messagingToolSentTexts = ["Completed."];
      execution.outcome.result.messagingToolSentTargets = routed
        ? [{ ...sourceReplyTarget, text: "Completed." }]
        : undefined;
      const decision = await decide(
        undefined,
        execution,
        createAccounting([{ text: "Completed." }]),
      );
      expect(decision).toMatchObject(
        delivered
          ? silent
          : { kind: "deliver", payloads: [{ isError: true, text: expect.any(String) }] },
      );
    },
  );

  it.each([
    {
      name: "total-only usage",
      usage: { total: 1250 },
      sessionMode: undefined,
      expected: "queued reply\nUsage: 1.3k total",
    },
    {
      name: "cache-only usage",
      usage: { cacheRead: 800, cacheWrite: 200 },
      sessionMode: undefined,
      expected: "queued reply\nUsage: ? in / ? out · cache 800 cached / 200 new",
    },
    {
      name: "an explicit usage-off preference",
      usage: { total: 1250 },
      sessionMode: "off",
      expected: "queued reply",
    },
  ] as const)(
    "delivers $name through the queued footer owner",
    async ({ usage, sessionMode, expected }) => {
      const turn = createTurn({ config: { messages: { responseUsage: "tokens" } } });
      const sourceDispatcher = vi.fn(async () => {});
      turn.queued.originatingChannel = "webchat";
      turn.queued.originatingTo = undefined;
      turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: sourceDispatcher };
      turn.session.current = () => ({
        sessionId: "session",
        updatedAt: 1,
        responseUsage: sessionMode,
      });

      const decision = await decide(
        turn,
        createSettledExecution("queued reply"),
        createAccounting([{ text: "queued reply" }], { usage }),
      );
      const delivery = await deliverDecision({
        decision,
        turn,
        runId: turn.runId,
      });
      expect(delivery).toMatchObject({ kind: "completed", payloads: [{ text: expected }] });
      expect(sourceDispatcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    { expectation: "required", providerStarted: true },
    { expectation: "result-required", providerStarted: true },
    { expectation: "result-required", providerStarted: false },
  ] as const)(
    "discards queued earlier answers after a $expectation silent final (providerStarted: $providerStarted)",
    async ({ expectation, providerStarted }) => {
      const { replyOperation, failMock } = createMockReplyOperation();
      const turn = createTurn({ operation: replyOperation });
      turn.queued.run.terminalReplyExpectation = expectation;
      turn.queued.strandedReplyRetry = true;
      const execution = createSettledExecution();
      execution.outcome.result.meta = {
        durationMs: 0,
        providerStarted,
        finalAssistantRawText: "NO_REPLY",
        yielded: true,
        yieldAcknowledgment: "An unsent confirmation",
        terminalReply: { disposition: "silent" },
      };
      const decision = await decide(
        turn,
        execution,
        createAccounting([{ text: "Earlier answer" }]),
      );
      expect(decision).toMatchObject(silent);
      expect(failMock).toHaveBeenCalledTimes(
        expectation === "result-required" && providerStarted ? 1 : 0,
      );
    },
  );

  it.each(["required", "optional"] as const)(
    "only reports an empty queued %s result when a reply is required",
    async (expectation) => {
      const { replyOperation, failMock } = createMockReplyOperation();
      const turn = createTurn({ operation: replyOperation });
      turn.queued.run.terminalReplyExpectation = expectation;
      const decision = await decide(turn);
      expect(decision).toMatchObject(
        expectation === "required"
          ? {
              kind: "deliver",
              payloads: [missingReply],
            }
          : silent,
      );
      expect(failMock).toHaveBeenCalledTimes(expectation === "required" ? 1 : 0);
    },
  );

  it.each(["automatic", "message_tool_only"] as const)(
    "keeps pending tool audio after queued NO_REPLY in %s mode",
    async (sourceReplyDeliveryMode) => {
      const turn = createTurn();
      turn.queued.run.sourceReplyDeliveryMode = sourceReplyDeliveryMode;
      const execution = createSettledExecution();
      execution.outcome.result.meta = {
        durationMs: 0,
        finalAssistantRawText: "NO_REPLY",
        terminalReply: { disposition: "silent" },
      };
      const media = setReplyPayloadMetadata(
        {
          text: "Unsent caption",
          mediaUrl: "https://example.invalid/pending.opus",
          audioAsVoice: true,
        },
        { assistantTranscriptOwned: true, deliverDespiteSourceReplySuppression: true },
      );
      const decision = await decide(
        turn,
        execution,
        createAccounting([{ text: "Unsent confirmation" }, media]),
      );
      expect(decision).toMatchObject({
        kind: "deliver",
        payloads: [{ mediaUrl: "https://example.invalid/pending.opus", audioAsVoice: true }],
      });
      if (decision.kind === "deliver") {
        expect(decision.payloads).toHaveLength(1);
        expect(decision.payloads[0]?.text).toBeUndefined();
        expect(
          getReplyPayloadMetadata(expectDefined(decision.payloads[0], "queued media payload")),
        ).toMatchObject({
          assistantTranscriptOwned: true,
          deliverDespiteSourceReplySuppression: true,
        });
      }
    },
  );

  it.each(["hook", "approval"] as const)(
    "preserves %s output even when a silent terminal marker is present",
    async (source) => {
      const execution = createSettledExecution();
      execution.outcome.result.meta = {
        durationMs: 0,
        terminalReply: { disposition: "silent" },
        ...(source === "hook"
          ? { error: { kind: "hook_block", message: "Blocked by policy." } as const }
          : {}),
      };
      execution.outcome.result.didSendDeterministicApprovalPrompt = source === "approval";
      const payload = { text: "Approval or policy notice", isStatusNotice: true };
      const decision = await decide(undefined, execution, createAccounting([payload]));
      expect(decision).toMatchObject({ kind: "deliver", payloads: [payload] });
    },
  );

  it.each(["room-event", "send-policy", "aborted"] as const)(
    "suppresses %s turns before projecting their final output",
    async (reason) => {
      const turn = createTurn({ sendPolicy: reason === "send-policy" ? "deny" : "allow" });
      if (reason === "room-event") {
        turn.queued.currentInboundEventKind = "room_event";
      }
      const execution: AgentTurnExecutionResult =
        reason === "aborted"
          ? {
              runId: "run-1",
              outcome: { kind: "aborted", reason: "user", compaction: { count: 1, durable: [] } },
            }
          : createSettledExecution(reason === "room-event" ? "private room final" : "blocked");
      expect(
        await decide(
          turn,
          execution,
          reason === "aborted" ? createAccounting([{ text: "late reply" }]) : undefined,
        ),
      ).toEqual({ kind: "suppress", reason });
    },
  );

  describe("stalled turn recovery run", () => {
    const stalledOperation = {
      result: { kind: "failed", code: "run_stalled" },
      staleExpiryReason: "stuck_recovery",
    } as AdmittedFollowupTurn["operation"];
    const aborted: AgentTurnExecutionResult = {
      runId: "run-1",
      outcome: { kind: "aborted", reason: "user" },
    };

    it.each([
      {
        label: "an ordinary queued request stalls",
        operation: stalledOperation,
        recovery: false,
      },
      {
        label: "the user stops the recovery run",
        operation: {
          result: { kind: "aborted", code: "aborted_by_user" },
        } as AdmittedFollowupTurn["operation"],
        recovery: true,
      },
    ])("stays silent when $label", async ({ operation, recovery }) => {
      const turn = createTurn({ operation });
      turn.queued.stalledTurnRecovery = recovery;

      expect(await decide(turn, aborted)).toEqual({
        kind: "suppress",
        reason: "aborted",
      });
    });
  });

  it.each([
    ["private failure", undefined, false, "channel", "message-tool-only", "private failure detail"],
    ["internal failure", undefined, false, "internal", "silent", "internal failure"],
    ["optional WebChat failure", "optional", false, "webchat", "silent", "internal failure"],
    ["approved required failure", "required", true, "channel", undefined, "visible failure"],
    ["approved optional failure", "optional", true, "channel", undefined, "visible failure"],
  ] as const)(
    "applies queued rejection visibility for %s",
    async (_name, expectation, approved, source, reason, text) => {
      const turn = createTurn();
      turn.queued.run.terminalReplyExpectation = expectation;
      if (source === "internal") {
        turn.queued.run.inputProvenance = { kind: "internal_system", sourceTool: "test" };
      } else if (source === "webchat") {
        turn.queued.originatingChannel = "webchat";
        turn.queued.run.messageProvider = "webchat";
      } else {
        turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
      }
      if (approved) {
        turn.queued.originatingChatType = "group";
        turn.queued.originatingReplyToMode = "all";
      }
      const payload = approved
        ? setReplyPayloadMetadata(
            { text, isError: true },
            { deliverDespiteSourceReplySuppression: true },
          )
        : { text };
      const decision = await decide(
        turn,
        { runId: "run-1", outcome: { kind: "rejected", payload } },
        undefined,
        source === "webchat" ? { onBlockReply: vi.fn(async () => {}) } : undefined,
      );
      if (approved) {
        expect(decision).toMatchObject({ kind: "deliver", payloads: [payload] });
        if (decision.kind === "deliver") {
          expect(getReplyPayloadMetadata(decision.payloads[0] ?? {})?.replyDelivery).toEqual({
            chatType: "group",
            replyToMode: "all",
          });
        }
      } else {
        expect(decision).toEqual({ kind: "suppress", reason });
      }
    },
  );

  it.each<{ name: string; payload?: ReplyPayload; sent?: boolean; deliver?: boolean }>([
    { name: "no marked payload" },
    {
      name: "visible marked media",
      payload: { mediaUrl: "file:///tmp/generated.png" },
      deliver: true,
    },
    {
      name: "already delivered media",
      payload: { mediaUrl: "file:///tmp/already-sent.png" },
      sent: true,
    },
  ])(
    "only lets deliverable marked content prevent stranded recovery: $name",
    async ({ payload, sent, deliver }) => {
      const turn = createTurn();
      turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
      const execution = createSettledExecution("The answer is ready.");
      if (sent && payload?.mediaUrl) {
        execution.outcome.result.messagingToolSentMediaUrls = [payload.mediaUrl];
      }
      const decision = await decide(
        turn,
        execution,
        createAccounting(
          payload
            ? [setReplyPayloadMetadata(payload, { deliverDespiteSourceReplySuppression: true })]
            : [],
        ),
      );
      expect(decision).toMatchObject(
        deliver
          ? { kind: "deliver", payloads: [{ mediaUrl: payload?.mediaUrl }] }
          : {
              kind: "retry-source-delivery",
              run: { strandedReplyRetry: true, disableCollectBatching: true },
            },
      );
    },
  );

  it("normalizes compaction notices with the runtime provider and originating context", async () => {
    const turn = createTurn();
    turn.queued.originatingChatType = "group";
    turn.queued.originatingReplyToMode = "all";
    const decision = await decide(
      turn,
      undefined,
      createAccounting([{ text: "done" }], {
        providerUsed: "claude-cli",
        modelUsed: "claude-sonnet-4-6",
        compactionNotice: { text: "compacted" },
      }),
    );
    expect(decision).toMatchObject({
      kind: "deliver",
      resolved: { provider: "claude-cli", model: "claude-sonnet-4-6" },
    });
    if (decision.kind === "deliver") {
      expect(getReplyPayloadMetadata(decision.payloads[0] ?? {})?.replyDelivery).toEqual({
        chatType: "group",
        replyToMode: "all",
      });
    }
  });

  it.each([
    { name: "internal follow-up", expectation: undefined, internal: true, final: "" },
    {
      name: "private final",
      expectation: undefined,
      internal: false,
      final: "This private text must not replace the sanitized failure.",
    },
  ] as const)(
    "preserves sanitized terminal failure policy for $name",
    async ({ expectation, internal, final }) => {
      const turn = createTurn();
      turn.queued.run.terminalReplyExpectation = expectation;
      if (internal) {
        turn.queued.run.inputProvenance = { kind: "internal_system", sourceTool: "test" };
      } else {
        turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
      }
      const failure = { text: internal ? "internal failure" : "terminal failure", isError: true };
      const execution = createSettledExecution(final);
      execution.outcome = {
        ...execution.outcome,
        status: "failed",
        terminalFailurePayload: failure,
      };
      const decision = await decide(
        turn,
        execution,
        createAccounting(final ? [{ text: "private partial" }] : [], {
          terminalFailurePayload: failure,
        }),
      );
      if (internal) {
        expect(decision).toEqual(silent);
      } else {
        expect(decision).toMatchObject({ kind: "deliver", payloads: [failure] });
      }
    },
  );

  it.each([
    { evidence: "empty", failureText: "The run failed after progress.", delivered: true },
    { evidence: "empty", failureText: "NO_REPLY", delivered: true },
    { evidence: "delivered", failureText: "The run failed after progress.", delivered: false },
    { evidence: "pending", failureText: "The run failed after progress.", delivered: false },
    { evidence: "blocked", failureText: "The run failed after progress.", delivered: false },
    { evidence: "ready", failureText: "The run failed after progress.", delivered: false },
  ] as const)(
    "settles optional failure $failureText with $evidence terminal custody",
    async ({ evidence, failureText, delivered }) => {
      const turn = createTurn();
      turn.queued.run.terminalReplyExpectation = "optional";
      turn.queued.originatingChatType = "group";
      const execution = createSettledExecution();
      const terminalFailurePayload = { text: failureText, isError: true };
      execution.outcome = {
        ...execution.outcome,
        status: "failed",
        terminalFailurePayload,
      };
      if (evidence === "delivered" || evidence === "pending") {
        execution.outcome.result.sourceReplyDeliveryState = evidence;
      } else if (evidence === "blocked") {
        execution.outcome.result.didSendDeterministicApprovalPrompt = true;
      }
      const readyPayloads = evidence === "ready" ? [{ text: "The answer is ready." }] : [];

      const decision = await decide(
        turn,
        execution,
        createAccounting(readyPayloads, { terminalFailurePayload }),
      );

      expect(decision).toMatchObject(
        delivered
          ? { kind: "deliver", payloads: [{ isError: true }] }
          : evidence === "ready"
            ? { kind: "deliver", payloads: readyPayloads }
            : silent,
      );
    },
  );

  it.each([
    ["progress-only target", { messagingToolSentTargets: [progressTarget] }, true],
    ["final source reply", { messagingToolSentTargets: [finalTarget] }, false],
    ["legacy source reply", { didDeliverSourceReplyViaMessageTool: true }, false],
    ["deterministic approval prompt", { didSendDeterministicApprovalPrompt: true }, false],
    [
      "visible progress while yielded",
      {
        meta: { durationMs: 0, yielded: true },
        messagingToolSentTargets: [progressTarget],
      },
      false,
    ],
    [
      "visible progress while continuation is pending",
      {
        meta: { durationMs: 0, continuationPending: true },
        messagingToolSentTargets: [progressTarget],
      },
      false,
    ],
    [
      "pending tool call",
      {
        meta: { durationMs: 0, pendingToolCalls: [{ id: "tool-1", name: "exec", arguments: {} }] },
      },
      false,
    ],
  ])(
    "accounts for %s before suppressing an empty follow-up",
    async (_label, evidence, expectFallback) => {
      const execution = createSettledExecution();
      Object.assign(execution.outcome.result, evidence);

      const decision = await decide(undefined, execution);

      expect(decision).toMatchObject(
        expectFallback
          ? {
              kind: "deliver",
              payloads: [missingReply],
            }
          : silent,
      );
    },
  );

  it("does not let private payloads settle a producer-declared empty message-tool final", async () => {
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";

    const decision = await decide(
      turn,
      undefined,
      createAccounting([{ text: "Private terminal diagnostic." }]),
    );

    expect(decision).toMatchObject({
      kind: "retry-source-delivery",
      run: { strandedReplyRetry: true },
    });
  });
});

describe("deliverFollowupDecision", () => {
  it("retains the event source delivery owner through progress and final settlement", async () => {
    const source = vi.fn(async () => {});
    const laterDispatcher = vi.fn(async () => {});
    const turn = createTurn();
    turn.queued.run.internalEventExecution = { onStarted: vi.fn(), onTerminal: vi.fn() };
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: source };
    deliveryState.routeReply.mockClear();
    const params = {
      turn,
      defaults: createDefaults(laterDispatcher),
      runId: "event-run",
    };
    await deliverDecision({
      ...params,
      kind: "block",
      decision: { kind: "deliver", payloads: [{ text: "progress" }] },
    });
    expect(source).toHaveBeenCalledExactlyOnceWith({
      kind: "queued-followup",
      runId: "event-run",
      originatingChannel: "discord",
      payloads: [{ text: "progress" }],
      completion: { kind: "progress" },
    });
    const final = await deliverDecision({
      ...params,
      decision: { kind: "deliver", payloads: [{ text: "done" }] },
    });
    expect(final).toEqual({ kind: "completed", payloads: [{ text: "done" }] });
    expect(source).toHaveBeenCalledOnce();
    expect(deliveryState.routeReply).not.toHaveBeenCalled();
    expect(laterDispatcher).not.toHaveBeenCalled();

    turn.queued.queuedFollowupReplyDisposition = undefined;
    await expect(
      deliverDecision({
        ...params,
        decision: { kind: "deliver", payloads: [{ text: "must not reroute" }] },
      }),
    ).rejects.toThrow("Internal event lost its originating delivery owner");
    expect(deliveryState.routeReply).not.toHaveBeenCalled();
    expect(laterDispatcher).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses the retained completion owner only for its channel (matching: %s)",
    async (matching) => {
      const source = Object.assign(
        vi.fn(async () => {}),
        {
          ownsCompletion: (channel: string | undefined) => matching && channel === "discord",
        },
      );
      const turn = createTurn();
      turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: source };
      deliveryState.routeReply.mockReset();
      deliveryState.routeReply.mockResolvedValue({ ok: true, delivered: true });
      deliveryState.followupRoute = { route: "origin" };
      const payloads = [{ text: "task-correlated answer" }];
      try {
        const result = await deliverDecision({
          turn,
          defaults: createDefaults(vi.fn()),
          decision: { kind: "deliver", payloads },
          runId: "queued-run",
        });
        expect(result).toEqual({ kind: "completed", payloads: matching ? payloads : [] });
        expect(deliveryState.routeReply).toHaveBeenCalledTimes(matching ? 0 : 1);
        expect(source).not.toHaveBeenCalled(); // The runner publishes the one terminal batch.
      } finally {
        deliveryState.followupRoute = undefined;
      }
    },
  );

  it("keeps a silent source event's successor off every automatic route", async () => {
    const dispatcher = vi.fn(async (_payload: ReplyPayload) => {});
    const turn = createTurn();
    turn.queued.run.sessionEventOrigin = { deliver: false };
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockResolvedValue({ ok: true, delivered: true });
    deliveryState.followupRoute = { route: "origin" };
    try {
      for (const kind of ["block", "final"] as const) {
        await expect(
          deliverDecision({
            turn,
            kind,
            defaults: createDefaults(dispatcher),
            decision: { kind: "deliver", payloads: [{ text: "Goal progress" }] },
          }),
        ).resolves.toEqual({ kind: "completed", payloads: [] });
      }
      expect(deliveryState.routeReply).not.toHaveBeenCalled();
      expect(dispatcher).not.toHaveBeenCalled();
    } finally {
      deliveryState.followupRoute = undefined;
    }
  });

  it("keeps dispatcher-only delivery out of a routable origin", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.followupRoute = { route: "dispatcher" };
    deliveryState.routeReply.mockReset();

    try {
      await deliverDecision({
        decision: { kind: "deliver", payloads: [{ text: "dispatcher only" }] },
        defaults: createDefaults(onBlockReply),
        runId: "run-1",
      });

      expect(onBlockReply).toHaveBeenCalledOnce();
      expect(deliveryState.routeReply).not.toHaveBeenCalled();
    } finally {
      deliveryState.followupRoute = undefined;
    }
  });

  it("keeps a source-unavailable WebChat reply dropped", async () => {
    const laterDispatcher = vi.fn(async (_payload: ReplyPayload) => {});
    const turn = createTurn();
    turn.queued.originatingChannel = "webchat";
    turn.queued.originatingTo = undefined;
    turn.queued.queuedFollowupReplyDisposition = { kind: "drop", reason: "source-unavailable" };
    await deliverDecision({
      decision: { kind: "deliver", payloads: [{ text: "must stay dropped" }] },
      turn,
      defaults: createDefaults(laterDispatcher),
    });
    expect(laterDispatcher).not.toHaveBeenCalled();
  });

  it("drains a source-delivery retry from its explicit store after the original turn completes", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:explicit-store-source-retry";
    const storePath = "/synthetic/source-retry/sessions.json";
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "source-retry-session",
      resetTriggered: false,
      target: captureSessionTarget({ storeScope: storePath, sessionKey, agentId: "main" }),
    });
    const owner = getSessionControllerEntryForOperation(operation);
    const turn = createTurn({
      operation,
      config: { messages: { queue: { mode: "followup" } } },
      session: {
        kind: "session",
        key: sessionKey,
        storePath,
        current: () => undefined,
        publish() {},
      },
    });
    turn.queued.run = {
      ...turn.queued.run,
      agentId: "main",
      sessionId: "source-retry-session",
      sessionKey,
      sourceReplyDeliveryMode: "message_tool_only",
    };
    let retry: FollowupRun | undefined;
    deliveryState.enqueue.mockImplementationOnce(
      (...args: Parameters<typeof enqueueFollowupRun>) => {
        retry = args[1];
        return enqueueFollowupRun(...args);
      },
    );
    const dispatched: string[] = [];
    const dispatch = vi.fn(async (run: FollowupRun) => {
      dispatched.push(run.prompt);
    });
    try {
      const decision = await decide(turn, createSettledExecution("The source answer is ready."));
      expect(decision.kind).toBe("retry-source-delivery");
      await expect(
        deliverDecision({
          decision,
          turn,
          defaults: createDefaults(vi.fn()),
          runId: turn.runId,
          runFollowup: dispatch,
        }),
      ).resolves.toEqual({ kind: "source-retry" });
      scheduleFollowupDrain(sessionKey, dispatch, owner);
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatched).toEqual([]);
      operation.complete();
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toContain("The source answer is ready.");
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      operation.complete();
      if (retry?.controllerInput) {
        retireSessionControllerInput(retry.controllerInput);
        await retry.controllerInput.settlement.promise;
        await retry.controllerInput.claim?.settlement.promise;
      }
      deliveryState.enqueue.mockReset();
      vi.useRealTimers();
    }
  });

  it("keeps recovery diagnostics deliverable after the original queued run completes", async () => {
    const delivered = vi.fn(async (_params: { runId: string; payloads: ReplyPayload[] }) => ({
      kind: "delivered" as const,
    }));
    const source = createChatSendLateFollowupDisposition({
      runId: "source-admission",
      originatingChannel: "webchat",
      logGateway: { info: vi.fn() } as never,
      deliver: delivered,
    });
    source.recordQueued();
    const turn = createTurn();
    turn.queued.originatingChannel = "webchat";
    turn.queued.originatingTo = undefined;
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: source.deliver };
    const defaults = createDefaults(vi.fn(async () => {}));
    const decision = await decide(turn, createSettledExecution("The answer is ready."));
    expect(decision.kind).toBe("retry-source-delivery");
    let retryRun: FollowupRun | undefined;
    deliveryState.enqueue.mockImplementation((_key: string, run: FollowupRun) => {
      retryRun = run;
      return true;
    });
    try {
      await deliverDecision({
        decision,
        turn,
        defaults,
        runId: turn.runId,
      });
      await source.deliver({
        kind: "queued-followup",
        runId: turn.runId,
        originatingChannel: "webchat",
        payloads: [],
        completion: { kind: "completed" },
      });
      if (!retryRun || retryRun.queuedFollowupReplyDisposition?.kind !== "deliver") {
        throw new Error("Recovery was not queued with its source delivery owner");
      }
      const retryTurn = { ...turn, runId: "retry-run", queued: retryRun };
      const diagnostic = await decide(
        retryTurn,
        createSettledExecution("Still unable to send the reply."),
      );
      if (diagnostic.kind !== "deliver") {
        throw new Error("Recovery did not prepare its terminal delivery diagnostic");
      }
      await retryRun.queuedFollowupReplyDisposition.deliver({
        kind: "queued-followup",
        runId: retryTurn.runId,
        originatingChannel: "webchat",
        payloads: diagnostic.payloads,
        completion: { kind: "completed" },
      });
      expect(deliveryState.enqueue).toHaveBeenCalledOnce();
      expect(delivered).toHaveBeenCalledTimes(2);
      expect(delivered).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ runId: turn.runId, payloads: [] }),
      );
      expect(delivered).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          runId: "retry-run",
          payloads: [
            expect.objectContaining({
              text: "No answer was returned. Ask again if you still need one.",
              isError: true,
              isStatusNotice: true,
            }),
          ],
        }),
      );
    } finally {
      deliveryState.enqueue.mockReset();
    }
  });

  it("keeps block-status delivery out of the assistant transcript", async () => {
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockResolvedValue({ ok: true, delivered: true });

    await deliverDecision({
      decision: { kind: "deliver", payloads: [{ text: "compacting" }] },
      defaults: createDefaults(vi.fn(async (_payload: ReplyPayload) => {})),
      runId: "run-1",
      kind: "block",
    });

    expect(deliveryState.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({ mirror: false, replyKind: "block" }),
    );
  });

  it.each([
    {
      name: "offline without a dispatcher",
      result: { ok: false, delivered: false, error: "offline" },
      dispatcher: false,
    },
    {
      name: "partial delivery",
      result: { ok: false, delivered: true, error: "later chunk failed" },
      dispatcher: true,
    },
    {
      name: "channel transform veto",
      result: { ok: true, delivered: false, suppressed: true, reason: "channel_transform" },
      dispatcher: true,
    },
  ])("does not retry $name", async ({ result, dispatcher }) => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.routeReply.mockReset();
    deliveryState.runtimeError.mockReset();
    deliveryState.routeReply.mockResolvedValue(result);
    const defaults = createDefaults(onBlockReply);
    await deliverDecision({
      decision: { kind: "deliver", payloads: [{ text: "reply" }] },
      defaults: { ...defaults, opts: dispatcher ? defaults.opts : undefined },
      runId: "run-1",
    });
    expect(onBlockReply).not.toHaveBeenCalled();
    if (!dispatcher) {
      expect(deliveryState.runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("route-reply failed: offline"),
      );
    }
  });
});
