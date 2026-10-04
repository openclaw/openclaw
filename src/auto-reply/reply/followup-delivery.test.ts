// Tests follow-up reply delivery and route preservation.
import { describe, expect, it, vi } from "vitest";
import { createChatSendLateFollowupDisposition } from "../../gateway/server-methods/chat-send-late-followup.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import {
  createAccounting,
  createDefaults,
  createSettledExecution,
  createTurn,
} from "./followup-delivery.test-support.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import type { FollowupRun } from "./queue/types.js";

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

vi.mock("../../agents/runtime-plan/build.js", () => ({
  buildAgentRuntimeDeliveryPlan: () => ({
    isSilentPayload: () => false,
    resolveFollowupRoute: () => deliveryState.followupRoute,
  }),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: (...args: unknown[]) => deliveryState.runtimeError(...args) },
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) => channel === "discord" || channel === "slack",
  routeReply: (...args: unknown[]) => deliveryState.routeReply(...args),
}));

describe("resolveFollowupDeliveryDecision", () => {
  const sourceReplyTarget = {
    tool: "message",
    provider: "discord",
    to: "channel:C1",
    text: "Still working",
  };
  const progressTarget = { ...sourceReplyTarget, sourceReplyFinal: false };
  const finalTarget = { ...sourceReplyTarget, sourceReplyFinal: true };
  const progressPayload = { text: "Still working", sourceReplyFinal: false };

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
      const decision = await resolveFollowupDeliveryDecision({
        turn: createTurn(),
        execution,
        accounting: createAccounting([{ text: "Completed." }]),
      });
      expect(decision).toMatchObject(
        delivered
          ? { kind: "suppress", reason: "silent" }
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

      const decision = await resolveFollowupDeliveryDecision({
        turn,
        execution: createSettledExecution("queued reply"),
        accounting: createAccounting([{ text: "queued reply" }], { usage }),
      });
      const delivery = await deliverFollowupDecision({
        decision,
        turn,
        defaults: createDefaults(vi.fn(async () => {})),
        runId: turn.runId,
        runFollowup: vi.fn(async () => {}),
      });
      expect(delivery).toMatchObject({ kind: "completed", payloads: [{ text: expected }] });
      expect(sourceDispatcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["yielded", undefined, false],
    ["continuationPending", undefined, false],
    ["yielded", "Research started; results will follow.", false],
    ["yielded", "Research started; results will follow.", true],
  ] as const)(
    "delivers waiting status for %s (%s, private partial=%s)",
    async (continuation, yieldAcknowledgment, privatePartial) => {
      const turn = createTurn();
      const execution = createSettledExecution();
      execution.outcome.result.meta = { durationMs: 0, [continuation]: true, yieldAcknowledgment };
      if (privatePartial) {
        turn.queued.originatingChatType = "group";
        turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
      } else {
        execution.outcome.result.acceptedSessionSpawns = [
          {
            runId: "child-run",
            childSessionKey: "agent:main:subagent:child",
            expectsCompletionMessage: true,
          },
        ];
      }
      expect(
        await resolveFollowupDeliveryDecision({
          turn,
          execution,
          accounting: createAccounting(privatePartial ? [{ text: "Private partial output." }] : []),
        }),
      ).toMatchObject({
        kind: "deliver",
        payloads: [
          {
            text:
              yieldAcknowledgment ??
              "I’m continuing this work and will send the result when it is ready.",
          },
        ],
      });
    },
  );

  it.each(["required", "optional"] as const)(
    "honors a queued %s reply expectation over NO_REPLY",
    async (expectation) => {
      const turn = createTurn();
      turn.queued.run.terminalReplyExpectation = expectation;
      const execution = createSettledExecution();
      execution.outcome.result.meta.finalAssistantRawText = "NO_REPLY";

      const decision = await resolveFollowupDeliveryDecision({
        turn,
        execution,
        accounting: createAccounting([{ text: "NO_REPLY" }]),
      });

      if (expectation === "optional") {
        expect(decision).toEqual({ kind: "suppress", reason: "silent" });
      } else {
        expect(decision).toMatchObject({
          kind: "deliver",
          payloads: [{ isError: true, text: expect.any(String) }],
        });
        if (decision.kind === "deliver") {
          expect(decision.payloads[0]?.text).not.toContain("NO_REPLY");
        }
      }
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
        await resolveFollowupDeliveryDecision({
          turn,
          execution,
          accounting: reason === "aborted" ? createAccounting([{ text: "late reply" }]) : undefined,
        }),
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

    it.each(["automatic", "message_tool_only"] as const)(
      "delivers the stall notice once the single recovery run stalls too (%s)",
      async (sourceReplyDeliveryMode) => {
        const turn = createTurn({ operation: stalledOperation });
        turn.queued.stalledTurnRecovery = true;
        turn.queued.run.sourceReplyDeliveryMode = sourceReplyDeliveryMode;

        const decision = await resolveFollowupDeliveryDecision({ turn, execution: aborted });

        expect(decision).toMatchObject({
          kind: "deliver",
          payloads: [
            {
              text: "⚠️ This turn was interrupted because it stopped making progress. Please try again.",
              isError: true,
            },
          ],
        });
      },
    );

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

      expect(await resolveFollowupDeliveryDecision({ turn, execution: aborted })).toEqual({
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
      const decision = await resolveFollowupDeliveryDecision({
        turn,
        execution: { runId: "run-1", outcome: { kind: "rejected", payload } },
        opts: source === "webchat" ? { onBlockReply: vi.fn(async () => {}) } : undefined,
      });
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
    { name: "blank marked text", payload: { text: "   " } },
    { name: "heartbeat marker", payload: { text: "HEARTBEAT_OK" } },
    { name: "private reasoning", payload: { text: "hidden reasoning", isReasoning: true } },
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
      const execution = createSettledExecution(
        "This is a substantive private answer that should have used the message tool. It has a second sentence so recovery is required.",
      );
      if (sent && payload?.mediaUrl) {
        execution.outcome.result.messagingToolSentMediaUrls = [payload.mediaUrl];
      }
      const decision = await resolveFollowupDeliveryDecision({
        turn,
        execution,
        accounting: createAccounting(
          payload
            ? [setReplyPayloadMetadata(payload, { deliverDespiteSourceReplySuppression: true })]
            : [],
        ),
      });
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
    const decision = await resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution(),
      accounting: createAccounting([{ text: "done" }], {
        providerUsed: "claude-cli",
        modelUsed: "claude-sonnet-4-6",
        compactionNotice: { text: "compacted" },
      }),
    });
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

  it("turns a second missing source delivery into a sanitized diagnostic", async () => {
    const turn = createTurn();
    turn.queued.strandedReplyRetry = true;
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";

    expect(
      await resolveFollowupDeliveryDecision({
        turn,
        execution: createSettledExecution(),
        accounting: createAccounting(),
      }),
    ).toMatchObject({
      kind: "deliver",
      payloads: [{ isError: true, isStatusNotice: true }],
    });
  });

  it.each([
    { name: "internal follow-up", expectation: undefined, internal: true, final: "" },
    { name: "required reply", expectation: "required", internal: false, final: "" },
    { name: "optional reply", expectation: "optional", internal: false, final: "" },
    {
      name: "substantive private final",
      expectation: undefined,
      internal: false,
      final:
        "This incomplete private text is substantive. It must not replace the sanitized failure.",
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
      const decision = await resolveFollowupDeliveryDecision({
        turn,
        execution: createSettledExecution(final),
        accounting: createAccounting(final ? [{ text: "private partial" }] : [], {
          terminalFailurePayload: failure,
        }),
      });
      if (internal) {
        expect(decision).toEqual({ kind: "suppress", reason: "silent" });
      } else {
        expect(decision).toMatchObject({ kind: "deliver", payloads: [failure] });
      }
    },
  );

  it.each([
    { evidence: "empty", failureText: "The run failed after progress.", delivered: true },
    { evidence: "empty", failureText: "Rate limit reached. Try again later.", delivered: true },
    { evidence: "empty", failureText: "NO_REPLY", delivered: false },
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

      const decision = await resolveFollowupDeliveryDecision({
        turn,
        execution,
        accounting: createAccounting(readyPayloads, { terminalFailurePayload }),
      });

      expect(decision).toMatchObject(
        delivered
          ? { kind: "deliver", payloads: [{ isError: true }] }
          : evidence === "ready"
            ? { kind: "deliver", payloads: readyPayloads }
            : { kind: "suppress", reason: "silent" },
      );
    },
  );

  it.each([
    ["progress-only target", { messagingToolSentTargets: [progressTarget] }, true],
    ["progress-only source payload", { messagingToolSourceReplyPayloads: [progressPayload] }, true],
    ["final source reply", { messagingToolSentTargets: [finalTarget] }, false],
    ["unclassified target", { messagingToolSentTargets: [sourceReplyTarget] }, true],
    ["legacy source reply", { didDeliverSourceReplyViaMessageTool: true }, false],
    ["unscoped outbound send", { didSendViaMessagingTool: true }, true],
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

      const decision = await resolveFollowupDeliveryDecision({
        turn: createTurn(),
        execution,
        accounting: createAccounting(),
      });

      expect(decision).toMatchObject(
        expectFallback
          ? {
              kind: "deliver",
              payloads: [
                { text: expect.stringContaining("did not produce a visible reply"), isError: true },
              ],
            }
          : { kind: "suppress", reason: "silent" },
      );
    },
  );

  it.each([
    ["accidental", undefined, undefined],
    ["intentional terminal tool", "tool-batch", undefined],
    ["private terminal diagnostic", undefined, "Private terminal diagnostic."],
  ] as const)(
    "accounts for %s message-tool-only completion",
    async (_label, intentionalTerminalCompletion, privateText) => {
      const turn = createTurn();
      turn.queued.originatingChatType = privateText ? "group" : turn.queued.originatingChatType;
      turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
      const execution = createSettledExecution();
      if (intentionalTerminalCompletion) {
        execution.outcome.result.meta.intentionalTerminalCompletion = intentionalTerminalCompletion;
      }

      const decision = await resolveFollowupDeliveryDecision({
        turn,
        execution,
        accounting: createAccounting(privateText ? [{ text: privateText }] : []),
      });
      if (privateText) {
        expect(decision).toEqual({ kind: "suppress", reason: "message-tool-only" });
        return;
      }

      expect(decision).toMatchObject({
        kind: "deliver",
        payloads: [
          { text: expect.stringContaining("did not produce a visible reply"), isError: true },
        ],
      });
      if (decision.kind === "deliver") {
        expect(
          getReplyPayloadMetadata(decision.payloads[0] ?? {})?.deliverDespiteSourceReplySuppression,
        ).toBe(true);
      }
    },
  );
});

describe("deliverFollowupDecision", () => {
  it.each(["final", "block", "tool"] as const)(
    "keeps internal occurrence %s delivery with its producer when the origin is routable",
    async (kind) => {
      const turn = createTurn();
      const deliver = vi.fn(async () => {});
      turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
      turn.queued.run.internalEventExecution = { onStarted: () => {}, onTerminal: () => {} };
      deliveryState.routeReply.mockClear();

      const result = await deliverFollowupDecision({
        decision: { kind: "deliver", payloads: [{ text: "internal result" }] },
        turn,
        defaults: createDefaults(vi.fn()),
        runId: "run-1",
        runFollowup: vi.fn(),
        kind,
      });

      expect(result).toEqual({ kind: "completed", payloads: [{ text: "internal result" }] });
      if (kind === "final") {
        // The follow-up runner delivers terminal payloads with the completion, once.
        expect(deliver).not.toHaveBeenCalled();
      } else {
        expect(deliver).toHaveBeenCalledExactlyOnceWith({
          kind: "queued-followup",
          runId: "run-1",
          originatingChannel: "discord",
          payloads: [{ text: "internal result" }],
          completion: { kind: "progress" },
        });
      }
      expect(deliveryState.routeReply).not.toHaveBeenCalled();
    },
  );

  it("keeps dispatcher-only delivery out of a routable origin", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.followupRoute = { route: "dispatcher" };
    deliveryState.routeReply.mockReset();

    try {
      await deliverFollowupDecision({
        decision: { kind: "deliver", payloads: [{ text: "dispatcher only" }] },
        turn: createTurn(),
        defaults: createDefaults(onBlockReply),
        runId: "run-1",
        runFollowup: vi.fn(async () => {}),
      });

      expect(onBlockReply).toHaveBeenCalledOnce();
      expect(deliveryState.routeReply).not.toHaveBeenCalled();
    } finally {
      deliveryState.followupRoute = undefined;
    }
  });

  it("keeps a queued WebChat reply bound to its original source dispatcher", async () => {
    const laterDispatcher = vi.fn(async (_payload: ReplyPayload) => {});
    const sourceDispatcher = vi.fn(async () => {});
    const turn = createTurn();
    turn.queued.originatingChannel = "webchat";
    turn.queued.originatingTo = undefined;
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: sourceDispatcher };
    deliveryState.followupRoute = { route: "dispatcher" };
    try {
      const payloads = await deliverFollowupDecision({
        decision: { kind: "deliver", payloads: [{ text: "one" }, { text: "two" }] },
        turn,
        defaults: createDefaults(laterDispatcher),
        runId: "source-run",
        runFollowup: vi.fn(async () => {}),
      });
      expect(payloads).toEqual({ kind: "completed", payloads: [{ text: "one" }, { text: "two" }] });
      expect(sourceDispatcher).not.toHaveBeenCalled();
      turn.queued.queuedFollowupReplyDisposition = {
        kind: "drop",
        reason: "source-unavailable",
      };
      await deliverFollowupDecision({
        decision: { kind: "deliver", payloads: [{ text: "must stay dropped" }] },
        turn,
        defaults: createDefaults(laterDispatcher),
        runId: "dropped-run",
        runFollowup: vi.fn(async () => {}),
      });
      expect(laterDispatcher).not.toHaveBeenCalled();
    } finally {
      deliveryState.followupRoute = undefined;
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
    const decision = await resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution(
        "This substantive reply should have been sent with the message tool. ".repeat(6),
      ),
      accounting: createAccounting(),
    });
    expect(decision.kind).toBe("retry-source-delivery");
    let retryRun: FollowupRun | undefined;
    deliveryState.enqueue.mockImplementation((_key: string, run: FollowupRun) => {
      retryRun = run;
      return true;
    });
    try {
      await deliverFollowupDecision({
        decision,
        turn,
        defaults,
        runId: turn.runId,
        runFollowup: vi.fn(async () => {}),
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
      const diagnostic = await resolveFollowupDeliveryDecision({
        turn: retryTurn,
        execution: createSettledExecution("Still unable to send the reply."),
        accounting: createAccounting(),
      });
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
              text: "I generated a reply but could not deliver it to this chat. Please try again.",
              isError: true,
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

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "compacting" }] },
      turn: createTurn(),
      defaults: createDefaults(vi.fn(async (_payload: ReplyPayload) => {})),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
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
    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "reply" }] },
      turn: createTurn(),
      defaults: { ...defaults, opts: dispatcher ? defaults.opts : undefined },
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });
    expect(onBlockReply).not.toHaveBeenCalled();
    if (!dispatcher) {
      expect(deliveryState.runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("route-reply failed: offline"),
      );
    }
  });
});
