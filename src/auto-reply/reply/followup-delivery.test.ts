// Tests follow-up reply delivery and route preservation.
import { describe, expect, it, vi } from "vitest";
import { createChatSendLateFollowupDisposition } from "../../gateway/server-methods/chat-send-late-followup.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
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

function createTurn(overrides: Partial<AdmittedFollowupTurn> = {}): AdmittedFollowupTurn {
  return {
    runId: "run-1",
    queued: {
      prompt: "queued",
      enqueuedAt: 1,
      originatingChannel: "discord",
      originatingTo: "channel:C1",
      run: {
        agentId: "agent",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey: "main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        provider: "anthropic",
        model: "claude",
        messageProvider: "discord",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: {} as AdmittedFollowupTurn["operation"],
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => undefined,
      publish: () => undefined,
      adopt: () => undefined,
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
    ...overrides,
  };
}

function createSettledExecution(finalText = ""): AgentTurnExecutionResult {
  return {
    runId: "run-1",
    outcome: {
      kind: "settled",
      status: "ok",
      result: {
        payloads: finalText ? [{ text: finalText }] : [],
        meta: { durationMs: 0, finalAssistantVisibleText: finalText },
      },
      resolved: { provider: "anthropic", model: "claude" },
      fallback: { exhausted: false, attempts: [] },
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
    },
  };
}

function createAccounting(
  payloadArray: ReplyPayload[] = [],
  overrides: Record<string, unknown> = {},
) {
  return {
    payloadArray,
    providerUsed: "anthropic",
    modelUsed: "claude",
    preserveUserFacingSessionState: false,
    replyUsageState: {},
    usage: undefined,
    terminalFailurePayload: undefined,
    ...overrides,
  } as never;
}

const createDefaults = (onBlockReply: (payload: ReplyPayload) => Promise<void>) => ({
  defaultModel: "claude",
  typingMode: "never" as const,
  typing: {
    onReplyStart: vi.fn(async () => {}),
    startTypingLoop: vi.fn(async () => {}),
    startTypingOnText: vi.fn(async () => {}),
    refreshTypingTtl: vi.fn(),
    isActive: vi.fn(() => false),
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    cleanup: vi.fn(),
  },
  opts: { onBlockReply },
});

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

      const decision = resolveFollowupDeliveryDecision({
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

  it("delivers a yield acknowledgment after accepting a child spawn", () => {
    const execution = createSettledExecution();
    if (execution.outcome.kind === "settled") {
      execution.outcome.result.meta = {
        durationMs: 0,
        yielded: true,
        yieldAcknowledgment: "Research started; results will follow.",
      };
      execution.outcome.result.acceptedSessionSpawns = [
        { runId: "child", childSessionKey: "agent:main:child" },
      ];
    }

    expect(
      resolveFollowupDeliveryDecision({
        turn: createTurn(),
        execution,
        accounting: createAccounting(),
      }),
    ).toMatchObject({
      kind: "deliver",
      payloads: [{ text: "Research started; results will follow." }],
    });
  });

  it("delivers a yield acknowledgment despite private partial output in group message-tool-only mode", () => {
    const turn = createTurn();
    turn.queued.originatingChatType = "group";
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    const execution = createSettledExecution();
    if (execution.outcome.kind === "settled") {
      execution.outcome.result.meta = {
        durationMs: 0,
        yielded: true,
        yieldAcknowledgment: "Research started; results will follow.",
      };
    }

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution,
        accounting: createAccounting([{ text: "Private partial output." }]),
      }),
    ).toMatchObject({
      kind: "deliver",
      payloads: [{ text: "Research started; results will follow." }],
    });
  });

  it("keeps ambient room-event finals silent", () => {
    const turn = createTurn({
      queued: {
        ...createTurn().queued,
        currentInboundEventKind: "room_event",
      },
    });

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution: createSettledExecution("private room final"),
      }),
    ).toEqual({ kind: "suppress", reason: "room-event" });
  });

  it("honors the admission-time send policy before any final projection", () => {
    expect(
      resolveFollowupDeliveryDecision({
        turn: createTurn({ sendPolicy: "deny" }),
        execution: createSettledExecution("blocked"),
      }),
    ).toEqual({ kind: "suppress", reason: "send-policy" });
  });

  it("does not deliver completed compaction facts from an aborted turn", () => {
    const execution: AgentTurnExecutionResult = {
      runId: "run-1",
      outcome: { kind: "aborted", reason: "user", compaction: { count: 1, durable: [] } },
    };

    expect(
      resolveFollowupDeliveryDecision({
        turn: createTurn(),
        execution,
        accounting: createAccounting([{ text: "late reply" }]),
      }),
    ).toEqual({ kind: "suppress", reason: "aborted" });
  });

  it("does not leak rejected private text in message-tool-only mode", () => {
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution: {
          runId: "run-1",
          outcome: { kind: "rejected", payload: { text: "private failure detail" } },
        },
      }),
    ).toEqual({ kind: "suppress", reason: "message-tool-only" });
  });

  it("keeps rejected failures silent for internal follow-ups", () => {
    const turn = createTurn();
    turn.queued.run.inputProvenance = { kind: "internal_system", sourceTool: "test" };

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution: {
          runId: "run-1",
          outcome: { kind: "rejected", payload: { text: "internal failure" } },
        },
      }),
    ).toEqual({ kind: "suppress", reason: "silent" });
  });

  it("keeps provenance-less internal-channel failures non-interactive", () => {
    const turn = createTurn();
    turn.queued.originatingChannel = "webchat";
    turn.queued.run.messageProvider = "webchat";

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution: {
          runId: "run-1",
          outcome: { kind: "rejected", payload: { text: "internal failure" } },
        },
        opts: { onBlockReply: vi.fn(async () => {}) },
      }),
    ).toEqual({ kind: "suppress", reason: "silent" });
  });

  it("normalizes rejected failures with the originating delivery context", () => {
    const turn = createTurn();
    turn.queued.originatingChatType = "group";
    turn.queued.originatingReplyToMode = "all";
    const payload = setReplyPayloadMetadata(
      { text: "visible failure", isError: true },
      { deliverDespiteSourceReplySuppression: true },
    );

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: {
        runId: "run-1",
        outcome: { kind: "rejected", payload },
      },
    });

    expect(decision.kind).toBe("deliver");
    if (decision.kind === "deliver") {
      expect(getReplyPayloadMetadata(decision.payloads[0] ?? {})?.replyDelivery).toEqual({
        chatType: "group",
        replyToMode: "all",
      });
    }
  });

  it("creates one priority retry for a substantive message-tool-only final", () => {
    const substantiveFinal =
      "This is a substantive private answer that should have used the message tool. It has a second sentence so recovery is required.";
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution(substantiveFinal),
      accounting: createAccounting(),
    });

    expect(decision).toMatchObject({
      kind: "retry-source-delivery",
      run: { strandedReplyRetry: true, disableCollectBatching: true },
    });
  });

  it("delivers explicitly allowed payloads before considering stranded recovery", () => {
    const substantiveFinal =
      "This is a substantive private answer that missed the message tool. It would normally trigger recovery.";
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    const explicitPayload = setReplyPayloadMetadata(
      { mediaUrl: "file:///tmp/generated.png" },
      { deliverDespiteSourceReplySuppression: true },
    );

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution(substantiveFinal),
      accounting: createAccounting([explicitPayload]),
    });

    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [{ mediaUrl: explicitPayload.mediaUrl }],
    });
  });

  it("normalizes explicitly allowed payloads before skipping stranded recovery", () => {
    const substantiveFinal =
      "This is a substantive private answer that missed the message tool. It must still trigger recovery when the marked payload is not deliverable.";
    const rawPayloads: ReplyPayload[] = [
      { text: "   " },
      { text: "HEARTBEAT_OK" },
      { text: "hidden reasoning", isReasoning: true },
    ];

    for (const rawPayload of rawPayloads) {
      const turn = createTurn();
      turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
      const explicitPayload = setReplyPayloadMetadata(rawPayload, {
        deliverDespiteSourceReplySuppression: true,
      });

      expect(
        resolveFollowupDeliveryDecision({
          turn,
          execution: createSettledExecution(substantiveFinal),
          accounting: createAccounting([explicitPayload]),
        }),
      ).toMatchObject({ kind: "retry-source-delivery" });
    }
  });

  it("recovers a substantive final after an explicitly allowed media payload is deduplicated", () => {
    const substantiveFinal =
      "This is a substantive private answer that missed the message tool. It must trigger recovery after its only marked media was already delivered.";
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    const mediaUrl = "file:///tmp/already-sent.png";
    const execution = createSettledExecution(substantiveFinal);
    if (execution.outcome.kind === "settled") {
      execution.outcome.result.messagingToolSentMediaUrls = [mediaUrl];
    }

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution,
        accounting: createAccounting([
          setReplyPayloadMetadata({ mediaUrl }, { deliverDespiteSourceReplySuppression: true }),
        ]),
      }),
    ).toMatchObject({ kind: "retry-source-delivery" });
  });

  it("routes settled delivery with the actual runtime provider", () => {
    const decision = resolveFollowupDeliveryDecision({
      turn: createTurn(),
      execution: createSettledExecution(),
      accounting: createAccounting([{ text: "done" }], {
        providerUsed: "claude-cli",
        modelUsed: "claude-sonnet-4-6",
      }),
    });

    expect(decision).toMatchObject({
      kind: "deliver",
      resolved: { provider: "claude-cli", model: "claude-sonnet-4-6" },
    });
  });

  it("normalizes auto-compaction notices with the originating delivery context", () => {
    const turn = createTurn();
    turn.queued.originatingChatType = "group";
    turn.queued.originatingReplyToMode = "all";

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution(),
      accounting: createAccounting([{ text: "done" }], {
        compactionNotice: { text: "compacted" },
      }),
    });

    expect(decision.kind).toBe("deliver");
    if (decision.kind === "deliver") {
      expect(getReplyPayloadMetadata(decision.payloads[0] ?? {})?.replyDelivery).toEqual({
        chatType: "group",
        replyToMode: "all",
      });
    }
  });

  it("turns a second missing source delivery into a sanitized diagnostic", () => {
    const turn = createTurn();
    turn.queued.strandedReplyRetry = true;
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution: createSettledExecution(),
        accounting: createAccounting(),
      }),
    ).toMatchObject({
      kind: "deliver-diagnostic",
      payload: { isError: true, isStatusNotice: true },
    });
  });

  it("keeps terminal failure fallback silent for internal follow-ups", () => {
    const turn = createTurn();
    turn.queued.run.inputProvenance = { kind: "internal_system", sourceTool: "test" };

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution: createSettledExecution(),
        accounting: createAccounting([], {
          terminalFailurePayload: { text: "internal failure", isError: true },
        }),
      }),
    ).toEqual({ kind: "suppress", reason: "silent" });
  });

  it("delivers a sanitized terminal failure in message-tool-only mode", () => {
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution(),
      accounting: createAccounting([], {
        terminalFailurePayload: { text: "terminal failure", isError: true },
      }),
    });

    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [{ text: "terminal failure", isError: true }],
    });
  });

  it.each([
    ["progress-only target", { messagingToolSentTargets: [progressTarget] }, true],
    ["progress-only source payload", { messagingToolSourceReplyPayloads: [progressPayload] }, true],
    ["final source reply", { messagingToolSentTargets: [finalTarget] }, false],
    ["legacy target", { messagingToolSentTargets: [sourceReplyTarget] }, false],
    ["legacy source reply", { didDeliverSourceReplyViaMessageTool: true }, false],
    ["legacy outbound send", { didSendViaMessagingTool: true }, false],
    ["deterministic approval prompt", { didSendDeterministicApprovalPrompt: true }, false],
    [
      "visible progress with yield acknowledgment",
      {
        meta: { durationMs: 0, yielded: true, yieldAcknowledgment: "Still working" },
        messagingToolSentTargets: [progressTarget],
      },
      false,
    ],
  ])(
    "accounts for %s before suppressing an empty follow-up",
    (_label, evidence, expectFallback) => {
      const execution = createSettledExecution();
      if (execution.outcome.kind === "settled") {
        Object.assign(execution.outcome.result, evidence);
      }

      const decision = resolveFollowupDeliveryDecision({
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
    (_label, intentionalTerminalCompletion, privateText) => {
      const turn = createTurn();
      turn.queued.originatingChatType = privateText ? "group" : turn.queued.originatingChatType;
      turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
      const execution = createSettledExecution();
      if (execution.outcome.kind === "settled" && intentionalTerminalCompletion) {
        execution.outcome.result.meta.intentionalTerminalCompletion = intentionalTerminalCompletion;
      }

      const decision = resolveFollowupDeliveryDecision({
        turn,
        execution,
        accounting: createAccounting(privateText ? [{ text: privateText }] : []),
      });
      if (intentionalTerminalCompletion || privateText) {
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

  it("keeps a terminal failure when suppressed partial output is present", () => {
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution(),
      accounting: createAccounting([{ text: "private partial" }], {
        terminalFailurePayload: { text: "terminal failure", isError: true },
      }),
    });

    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [{ text: "terminal failure", isError: true }],
    });
  });

  it("prefers terminal failure over stranded-text recovery", () => {
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    const execution = createSettledExecution(
      "This incomplete private text is substantive. It must not replace the sanitized failure.",
    );

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution,
      accounting: createAccounting([], {
        terminalFailurePayload: { text: "terminal failure", isError: true },
      }),
    });

    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [{ text: "terminal failure", isError: true }],
    });
  });
});

describe("deliverFollowupDecision", () => {
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
    const decision = resolveFollowupDeliveryDecision({
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
      const diagnostic = resolveFollowupDeliveryDecision({
        turn: retryTurn,
        execution: createSettledExecution("Still unable to send the reply."),
        accounting: createAccounting(),
      });
      if (diagnostic.kind !== "deliver-diagnostic") {
        throw new Error("Recovery did not prepare its terminal delivery diagnostic");
      }
      await retryRun.queuedFollowupReplyDisposition.deliver({
        kind: "queued-followup",
        runId: retryTurn.runId,
        originatingChannel: "webchat",
        payloads: [diagnostic.payload],
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

  it("allows the latest same-channel dispatcher to recover a route failure", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockResolvedValue({
      ok: false,
      delivered: false,
      error: "offline",
    });
    const turn = createTurn();
    turn.queued.run.messageProvider = "discord";

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "same-channel reply" }] },
      turn,
      defaults: createDefaults(onBlockReply),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "same-channel reply" }),
    );
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

  it("reports an origin delivery failure when no dispatcher can recover it", async () => {
    deliveryState.routeReply.mockReset();
    deliveryState.runtimeError.mockReset();
    deliveryState.routeReply.mockResolvedValue({
      ok: false,
      delivered: false,
      error: "offline",
    });

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "undelivered" }] },
      turn: createTurn(),
      defaults: {
        defaultModel: "claude",
        typingMode: "never",
        typing: createDefaults(vi.fn(async (_payload: ReplyPayload) => {})).typing,
      },
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(deliveryState.runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("route-reply failed: offline"),
    );
  });

  it("does not duplicate a follow-up after a partial route failure delivered it", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockResolvedValue({
      ok: false,
      delivered: true,
      error: "later chunk failed",
    });
    const turn = createTurn();
    turn.queued.run.messageProvider = "discord";

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "already delivered" }] },
      turn,
      defaults: createDefaults(onBlockReply),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("does not retry a channel-transform-suppressed routed follow-up", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockResolvedValue({
      ok: true,
      delivered: false,
      suppressed: true,
      reason: "channel_transform",
    });

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "private reply" }] },
      turn: createTurn(),
      defaults: createDefaults(onBlockReply),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });
});
