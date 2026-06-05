// Diagnostic stability tests cover stable diagnostic output under repeated events.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
  resetDiagnosticStabilityRecorderForTest,
  selectDiagnosticStabilitySnapshot,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
  type DiagnosticStabilitySnapshot,
} from "./diagnostic-stability.js";

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

describe("diagnostic stability recorder", () => {
  beforeEach(() => {
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
  });

  it("records a bounded payload-free projection of diagnostic events", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "webhook.error",
      channel: "telegram",
      chatId: "chat-secret",
      error: "raw upstream error with content",
    });
    emitDiagnosticEvent({
      type: "tool.loop",
      sessionId: "session-1",
      toolName: "poll",
      level: "warning",
      action: "warn",
      detector: "known_poll_no_progress",
      count: 3,
      message: "message that should not be stored",
    });
    emitDiagnosticEvent({
      type: "talk.event",
      sessionId: "talk-session-secret",
      turnId: "talk-turn-secret",
      captureId: "talk-capture-secret",
      talkEventType: "latency.metrics",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
      final: true,
      durationMs: 12,
      byteLength: 345,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.count).toBe(3);
    expectFields(snapshot.summary.byType, {
      "webhook.error": 1,
      "tool.loop": 1,
      "talk.event": 1,
    });
    expectFields(snapshot.events[0], {
      type: "webhook.error",
      channel: "telegram",
    });
    expect(snapshot.events[0]).not.toHaveProperty("error");
    expect(snapshot.events[0]).not.toHaveProperty("chatId");
    expectFields(snapshot.events[1], {
      type: "tool.loop",
      toolName: "poll",
      level: "warning",
      action: "warn",
      detector: "known_poll_no_progress",
      count: 3,
    });
    expect(snapshot.events[1]).not.toHaveProperty("message");
    expect(snapshot.events[1]).not.toHaveProperty("sessionId");
    expect(snapshot.events[1]).not.toHaveProperty("sessionKey");
    expectFields(snapshot.events[2], {
      type: "talk.event",
      talkEventType: "latency.metrics",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
      final: true,
      durationMs: 12,
      bytes: 345,
    });
    expect(snapshot.events[2]).not.toHaveProperty("sessionId");
    expect(snapshot.events[2]).not.toHaveProperty("turnId");
    expect(snapshot.events[2]).not.toHaveProperty("captureId");
  });

  it("summarizes session attention without storing private context", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "session.long_running",
      sessionKey: "agent:main:telegram:direct:owner",
      state: "processing",
      ageMs: 45_000,
      queueDepth: 1,
      reason: "queued_behind_active_work",
      classification: "long_running",
      activeWorkKind: "embedded_run",
    });
    emitDiagnosticEvent({
      type: "session.stalled",
      sessionKey: "agent:main:telegram:direct:owner",
      state: "processing",
      ageMs: 90_000,
      queueDepth: 2,
      reason: "blocked_tool_call",
      classification: "blocked_tool_call",
      activeWorkKind: "tool_call",
      activeToolName: "home_assistant",
      activeToolCallId: "call-secret",
      activeToolAgeMs: 31_000,
    });
    emitDiagnosticEvent({
      type: "session.stuck",
      sessionKey: "agent:main:telegram:direct:owner",
      state: "idle",
      ageMs: 120_000,
      queueDepth: 1,
      reason: "queued_work_without_active_run",
      classification: "stale_session_state",
    });
    emitDiagnosticEvent({
      type: "session.recovery.completed",
      sessionKey: "agent:main:telegram:direct:owner",
      state: "idle",
      ageMs: 121_000,
      queueDepth: 0,
      reason: "queued_work_without_active_run",
      status: "released",
      action: "recover",
      released: 1,
    });
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.summary.sessions?.attention).toMatchObject({
      longRunning: 1,
      stalled: 1,
      stuck: 1,
      recoveryRequested: 0,
      recoveryCompleted: 1,
      byClassification: {
        long_running: 1,
        blocked_tool_call: 1,
        stale_session_state: 1,
        queued_work_without_active_run: 1,
      },
      byActiveWorkKind: {
        embedded_run: 1,
        tool_call: 1,
      },
    });
    expect(snapshot.summary.sessions?.attention.recent).toEqual([
      expect.objectContaining({
        type: "session.long_running",
        classification: "long_running",
        activeWorkKind: "embedded_run",
        ageMs: 45_000,
        queueDepth: 1,
      }),
      expect.objectContaining({
        type: "session.stalled",
        classification: "blocked_tool_call",
        activeWorkKind: "tool_call",
        toolName: "home_assistant",
        ageMs: 90_000,
        queueDepth: 2,
      }),
      expect.objectContaining({
        type: "session.stuck",
        classification: "stale_session_state",
        reason: "queued_work_without_active_run",
      }),
      expect.objectContaining({
        type: "session.recovery.completed",
        reason: "queued_work_without_active_run",
      }),
    ]);
    expect(snapshot.events.find((event) => event.type === "session.stalled")).toMatchObject({
      classification: "blocked_tool_call",
      activeWorkKind: "tool_call",
      toolName: "home_assistant",
    });
    expect(snapshot.events.find((event) => event.type === "session.stalled")).not.toHaveProperty(
      "sessionKey",
    );
    expect(snapshot.summary.recommendations).toEqual([
      expect.objectContaining({
        code: "inspect_blocked_tool",
        priority: "high",
        source: "sessions",
        reason: "blocked_tool_call",
        count: 1,
      }),
      expect.objectContaining({
        code: "recover_stale_session",
        priority: "high",
        source: "sessions",
        reason: "session_stuck",
        count: 1,
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private message body");
  });

  it("summarizes queue lane waits without exposing session lanes", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "queue.lane.enqueue",
      lane: "session:agent:main:telegram:direct:owner",
      queueSize: 3,
    });
    emitDiagnosticEvent({
      type: "queue.lane.dequeue",
      lane: "session:agent:main:telegram:direct:owner",
      queueSize: 2,
      waitMs: 12_500,
    });
    emitDiagnosticEvent({
      type: "queue.lane.enqueue",
      lane: "main",
      queueSize: 1,
    });
    emitDiagnosticEvent({
      type: "queue.lane.dequeue",
      lane: "main",
      queueSize: 0,
      waitMs: 250,
    });
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.summary.queues).toMatchObject({
      enqueued: 2,
      dequeued: 2,
      slowDequeues: 1,
      maxWaitMs: 12_500,
      maxQueueSize: 3,
      byLane: {
        session: {
          enqueued: 1,
          dequeued: 1,
          slowDequeues: 1,
          maxWaitMs: 12_500,
          maxQueueSize: 3,
        },
        main: {
          enqueued: 1,
          dequeued: 1,
          slowDequeues: 0,
          maxWaitMs: 250,
          maxQueueSize: 1,
        },
      },
      recentSlow: [
        expect.objectContaining({
          lane: "session",
          waitMs: 12_500,
          queueSize: 2,
        }),
      ],
    });
    expect(snapshot.summary.controlLane).toMatchObject({
      status: "warning",
      reasons: ["queue_pressure"],
      slowQueue: 1,
      maxQueueWaitMs: 12_500,
    });
    expect(snapshot.summary.recommendations).toEqual([
      expect.objectContaining({
        code: "clear_queue_pressure",
        priority: "medium",
        source: "queues",
        reason: "slow_queue_dequeue",
        metric: "waitMs",
        valueMs: 12_500,
        count: 1,
      }),
    ]);
    expect(JSON.stringify(snapshot.summary.queues)).not.toContain("telegram:direct:owner");
  });

  it("keeps stable reason codes but drops free-form reason text", () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "payload.large",
      surface: "gateway.http.json",
      action: "rejected",
      reason: "json_body_limit",
    });
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "error",
      reason: "raw error with user content",
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expectFields(snapshot.events[0], {
      type: "payload.large",
      reason: "json_body_limit",
    });
    expectFields(snapshot.events[1], {
      type: "message.processed",
      outcome: "error",
    });
    expect(snapshot.events[1]).not.toHaveProperty("reason");
  });

  it("summarizes inbound delivery proof events without message content", () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "message.received",
      channel: "signal",
      sessionKey: "agent:main:signal:direct:u1",
      messageId: "msg-secret",
      chatId: "chat-secret",
      source: "dispatchInboundMessage",
    });
    emitDiagnosticEvent({
      type: "message.dispatch.started",
      channel: "signal",
      sessionKey: "agent:main:signal:direct:u1",
      source: "replyResolver",
    });
    emitDiagnosticEvent({
      type: "message.dispatch.completed",
      channel: "signal",
      sessionKey: "agent:main:signal:direct:u1",
      source: "replyResolver",
      durationMs: 12,
      outcome: "completed",
    });
    emitDiagnosticEvent({
      type: "session.turn.created",
      runId: "run-1",
      sessionKey: "agent:main:signal:direct:u1",
      sessionId: "session-secret",
      agentId: "main",
      channel: "signal",
      trigger: "user",
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.summary.byType).toMatchObject({
      "message.received": 1,
      "message.dispatch.started": 1,
      "message.dispatch.completed": 1,
      "session.turn.created": 1,
    });
    expect(snapshot.events).toEqual([
      expect.objectContaining({
        type: "message.received",
        channel: "signal",
        source: "dispatchInboundMessage",
      }),
      expect.objectContaining({
        type: "message.dispatch.started",
        channel: "signal",
        source: "replyResolver",
      }),
      expect.objectContaining({
        type: "message.dispatch.completed",
        channel: "signal",
        source: "replyResolver",
        outcome: "completed",
      }),
      expect.objectContaining({
        type: "session.turn.created",
        channel: "signal",
        source: "main",
        outcome: "user",
      }),
    ]);
    for (const event of snapshot.events) {
      expect(event).not.toHaveProperty("messageId");
      expect(event).not.toHaveProperty("chatId");
      expect(event).not.toHaveProperty("sessionId");
      expect(event).not.toHaveProperty("sessionKey");
    }
  });

  it("summarizes assembled context diagnostics without prompt text", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "context.assembled",
      runId: "run-secret",
      sessionId: "session-secret",
      provider: "openai",
      model: "gpt-5.4",
      channel: "telegram",
      trigger: "user-message",
      messageCount: 4,
      historyTextChars: 1200,
      historyImageBlocks: 1,
      maxMessageTextChars: 800,
      systemPromptChars: 300,
      promptChars: 100,
      promptImages: 1,
      contextTokenBudget: 200_000,
      reserveTokens: 20_000,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expectFields(snapshot.events[0], {
      type: "context.assembled",
      provider: "openai",
      model: "gpt-5.4",
      channel: "telegram",
      count: 4,
      context: { limit: 200_000 },
    });
    expect(snapshot.events[0]).not.toHaveProperty("runId");
    expect(snapshot.events[0]).not.toHaveProperty("sessionId");
    expect(snapshot.events[0]).not.toHaveProperty("promptChars");
    expect(snapshot.events[0]).not.toHaveProperty("systemPromptChars");
  });

  it("sanitizes tool and model diagnostic error categories", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "tool.execution.error",
      toolName: "read",
      durationMs: 1,
      errorCategory: "bad reason\nwith content",
    });
    emitDiagnosticEvent({
      type: "model.call.error",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 1,
      requestPayloadBytes: 1234,
      responseStreamBytes: 567,
      timeToFirstByteMs: 89,
      errorCategory: "TypeError",
      failureKind: "terminated",
      memory: {
        rssBytes: 100,
        heapTotalBytes: 80,
        heapUsedBytes: 40,
        externalBytes: 20,
        arrayBuffersBytes: 10,
      },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expectFields(snapshot.events[0], {
      type: "tool.execution.error",
      toolName: "read",
    });
    expect(snapshot.events[0]).not.toHaveProperty("reason");
    expectFields(snapshot.events[1], {
      type: "model.call.error",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 1,
      requestBytes: 1234,
      responseBytes: 567,
      timeToFirstByteMs: 89,
      reason: "TypeError",
      failureKind: "terminated",
      memory: {
        rssBytes: 100,
        heapTotalBytes: 80,
        heapUsedBytes: 40,
        externalBytes: 20,
        arrayBuffersBytes: 10,
      },
    });
    expect(JSON.stringify(snapshot.events[1])).not.toContain("call-1");
  });

  it("summarizes memory and large payload events", () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "diagnostic.memory.sample",
      memory: {
        rssBytes: 100,
        heapTotalBytes: 80,
        heapUsedBytes: 40,
        externalBytes: 10,
        arrayBuffersBytes: 5,
      },
    });
    emitDiagnosticEvent({
      type: "diagnostic.memory.pressure",
      level: "warning",
      reason: "rss_threshold",
      thresholdBytes: 90,
      memory: {
        rssBytes: 120,
        heapTotalBytes: 90,
        heapUsedBytes: 50,
        externalBytes: 10,
        arrayBuffersBytes: 5,
      },
    });
    emitDiagnosticEvent({
      type: "payload.large",
      surface: "gateway.http.json",
      action: "rejected",
      bytes: 1024,
      limitBytes: 512,
      reason: "content-length",
    });

    const snapshot = getDiagnosticStabilitySnapshot();

    expectFields(snapshot.summary.memory, {
      maxRssBytes: 120,
      maxHeapUsedBytes: 50,
      pressureCount: 1,
    });
    expectFields(snapshot.summary.memory?.latest, {
      rssBytes: 120,
      heapUsedBytes: 50,
    });
    expect(snapshot.summary.payloadLarge).toEqual({
      count: 1,
      rejected: 1,
      truncated: 0,
      chunked: 0,
      bySurface: {
        "gateway.http.json": 1,
      },
    });
  });

  it("summarizes channel turn delivery SLA failures without message content", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      accountId: "acct",
      turnId: "telegram:acct:message:msg-1",
      sessionKey: "agent:main:telegram:direct:owner",
      messageId: "msg-1",
      target: "sebastian",
      turnEventType: "delivery.required",
      status: "required",
      messageAgeMs: 30_000,
    });
    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      accountId: "acct",
      turnId: "telegram:acct:message:msg-1",
      sessionKey: "agent:main:telegram:direct:owner",
      messageId: "msg-1",
      target: "sebastian",
      turnEventType: "delivery.failed",
      status: "failed",
      reason: "missing_visible_delivery",
      startToDeliveryMs: 2_500,
    });
    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      accountId: "acct",
      turnId: "telegram:acct:message:msg-1",
      sessionKey: "agent:main:telegram:direct:owner",
      messageId: "msg-1",
      target: "sebastian",
      turnEventType: "turn.failed",
      status: "invalid",
      reason: "missing_visible_delivery",
      completionAllowed: false,
      visibleDeliveryRequired: true,
      visibleDeliverySent: false,
      startToCompletionMs: 2_700,
    });
    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      turnId: "telegram:acct:message:msg-2",
      messageId: "msg-2",
      turnEventType: "delivery.sent",
      status: "sent",
      receivedToTurnStartMs: 12_000,
    });
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.summary.channelTurns).toMatchObject({
      totalEvents: 4,
      deliveryRequired: 1,
      deliverySent: 1,
      deliveryFailed: 1,
      invalidCompletions: 1,
      missingVisibleDelivery: 2,
      health: {
        status: "degraded",
        issues: [
          {
            code: "missing_visible_delivery",
            level: "degraded",
            count: 2,
          },
          {
            code: "stale_message_at_receive",
            level: "warning",
            metric: "messageAgeMs",
            valueMs: 30_000,
            count: 1,
          },
          {
            code: "slow_receive_to_turn_start",
            level: "warning",
            metric: "receivedToTurnStartMs",
            valueMs: 12_000,
            count: 1,
          },
        ],
      },
      byChannel: {
        telegram: {
          deliveryRequired: 1,
          deliverySent: 1,
          deliveryFailed: 1,
          invalidCompletions: 1,
          missingVisibleDelivery: 2,
        },
      },
    });
    expect(snapshot.summary.channelTurns?.recentFailures).toEqual([
      {
        seq: expect.any(Number),
        ts: expect.any(Number),
        channel: "telegram",
        turnId: "telegram:acct:message:msg-1",
        sessionKey: "agent:main:telegram:direct:owner",
        messageId: "msg-1",
        reason: "missing_visible_delivery",
      },
      {
        seq: expect.any(Number),
        ts: expect.any(Number),
        channel: "telegram",
        turnId: "telegram:acct:message:msg-1",
        sessionKey: "agent:main:telegram:direct:owner",
        messageId: "msg-1",
        reason: "missing_visible_delivery",
      },
    ]);
    expect(snapshot.summary.channelTurns?.latency).toMatchObject({
      messageAgeMs: {
        count: 1,
        slowCount: 1,
        latestMs: 30_000,
        maxMs: 30_000,
        p50Ms: 30_000,
        p90Ms: 30_000,
        p95Ms: 30_000,
      },
      receivedToTurnStartMs: {
        count: 1,
        slowCount: 1,
        latestMs: 12_000,
        maxMs: 12_000,
        p50Ms: 12_000,
        p90Ms: 12_000,
        p95Ms: 12_000,
      },
      startToDeliveryMs: {
        count: 1,
        slowCount: 0,
        latestMs: 2_500,
        maxMs: 2_500,
        p50Ms: 2_500,
        p90Ms: 2_500,
        p95Ms: 2_500,
      },
      startToCompletionMs: {
        count: 1,
        slowCount: 0,
        latestMs: 2_700,
        maxMs: 2_700,
        p50Ms: 2_700,
        p90Ms: 2_700,
        p95Ms: 2_700,
      },
      bottleneck: {
        phase: "ingress",
        metric: "messageAgeMs",
        maxMs: 30_000,
        slowCount: 1,
        count: 1,
      },
    });
    expect(snapshot.summary.channelTurns?.latency?.recentSlow).toEqual([
      expect.objectContaining({
        channel: "telegram",
        messageId: "msg-1",
        metric: "messageAgeMs",
        valueMs: 30_000,
      }),
      expect.objectContaining({
        channel: "telegram",
        messageId: "msg-2",
        metric: "receivedToTurnStartMs",
        valueMs: 12_000,
      }),
    ]);
    expect(snapshot.summary.controlLane).toMatchObject({
      status: "degraded",
      reasons: ["missing_visible_delivery", "stale_ingress", "queue_pressure"],
      deliveryRequired: 1,
      deliverySent: 1,
      deliveryFailed: 1,
      missingVisibleDelivery: 2,
      slowIngress: 1,
      slowQueue: 1,
      maxMessageAgeMs: 30_000,
      maxReceiveToStartMs: 12_000,
    });
    expect(snapshot.events[0]).not.toHaveProperty("accountId");
    expect(snapshot.events[0]).toHaveProperty("target", "kind:named");
    expect(snapshot.summary.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "inspect_missing_delivery",
          priority: "high",
          source: "channel_turns",
          reason: "missing_visible_delivery",
          count: 2,
        }),
        expect.objectContaining({
          code: "inspect_gateway_ingress",
          priority: "medium",
          source: "channel_turns",
          reason: "stale_message_at_receive",
          metric: "messageAgeMs",
          valueMs: 30_000,
          count: 1,
        }),
        expect.objectContaining({
          code: "clear_queue_pressure",
          priority: "medium",
          source: "channel_turns",
          reason: "slow_receive_to_turn_start",
          metric: "receivedToTurnStartMs",
          valueMs: 12_000,
          count: 1,
        }),
      ]),
    );
    expect(JSON.stringify(snapshot)).not.toContain("hello");
    expect(JSON.stringify(snapshot)).not.toContain("sebastian");
  });

  it("summarizes channel turn targets without storing concrete destination ids", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      turnId: "turn-channel",
      target: "channel:C123456789",
      turnEventType: "turn.started",
    });
    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      turnId: "turn-numeric",
      target: "-100123456789",
      turnEventType: "turn.started",
    });
    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      turnId: "turn-contact",
      target: "+49123456789",
      turnEventType: "turn.started",
    });

    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.events.map((event) => event.target)).toEqual([
      "kind:channel",
      "kind:numeric-id",
      "kind:contact",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("C123456789");
    expect(JSON.stringify(snapshot)).not.toContain("-100123456789");
    expect(JSON.stringify(snapshot)).not.toContain("+49123456789");
  });

  it("summarizes channel turn tool lifecycle health without storing payloads", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      turnId: "turn-tool-ok",
      turnEventType: "tool.called",
      toolName: "exec",
      toolCallId: "call-ok",
      status: "started",
    });
    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      turnId: "turn-tool-ok",
      turnEventType: "tool.result",
      toolName: "exec",
      toolCallId: "call-ok",
      status: "completed",
      durationMs: 12_500,
      isError: false,
    });
    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      turnId: "turn-tool-failed",
      turnEventType: "tool.called",
      toolName: "message",
      toolCallId: "call-failed",
      status: "started",
    });
    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      turnId: "turn-tool-failed",
      turnEventType: "tool.result",
      toolName: "message",
      toolCallId: "call-failed",
      status: "failed",
      durationMs: 250,
      isError: true,
      errorCategory: "network",
    });
    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      turnId: "turn-tool-missing",
      turnEventType: "tool.called",
      toolName: "calendar",
      toolCallId: "call-missing",
      status: "started",
    });
    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      turnId: "turn-tool-missing",
      turnEventType: "turn.completed",
      status: "valid",
    });
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.summary.channelTurns?.tools).toMatchObject({
      called: 3,
      results: 2,
      failedResults: 1,
      missingResults: 1,
      slowResults: 1,
      preDeliveryCalls: 0,
      slowPreDeliveryResults: 0,
      byTool: {
        exec: {
          called: 1,
          results: 1,
          failedResults: 0,
          missingResults: 0,
          slowResults: 1,
          preDeliveryCalls: 0,
          slowPreDeliveryResults: 0,
          maxDurationMs: 12_500,
        },
        message: {
          called: 1,
          results: 1,
          failedResults: 1,
          missingResults: 0,
          slowResults: 0,
          preDeliveryCalls: 0,
          slowPreDeliveryResults: 0,
          maxDurationMs: 250,
        },
        calendar: {
          called: 1,
          results: 0,
          failedResults: 0,
          missingResults: 1,
          slowResults: 0,
          preDeliveryCalls: 0,
          slowPreDeliveryResults: 0,
        },
      },
    });
    expect(snapshot.summary.channelTurns?.health.issues.map((issue) => issue.code)).toEqual([
      "tool_result_failed",
      "tool_result_missing",
      "slow_tool_result",
    ]);
    expect(snapshot.summary.channelTurns?.tools?.recentSlow).toEqual([
      expect.objectContaining({
        channel: "telegram",
        turnId: "turn-tool-ok",
        toolName: "exec",
        durationMs: 12_500,
      }),
    ]);
    expect(snapshot.summary.channelTurns?.tools?.recentFailures).toEqual([
      expect.objectContaining({
        channel: "telegram",
        turnId: "turn-tool-failed",
        toolName: "message",
        reason: "network",
      }),
      expect.objectContaining({
        channel: "telegram",
        turnId: "turn-tool-missing",
        toolName: "calendar",
        reason: "missing_tool_result",
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("payload");
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });

  it("flags slow tool work that starts before visible delivery", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      turnId: "turn-pre-delivery",
      messageId: "msg-pre-delivery",
      turnEventType: "delivery.required",
      status: "required",
    });
    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      turnId: "turn-pre-delivery",
      turnEventType: "tool.called",
      toolName: "home_assistant",
      toolCallId: "call-ha",
      status: "started",
    });
    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      turnId: "turn-pre-delivery",
      turnEventType: "tool.result",
      toolName: "home_assistant",
      toolCallId: "call-ha",
      status: "completed",
      durationMs: 18_000,
      isError: false,
    });
    emitDiagnosticEvent({
      type: "channel.turn.event",
      channel: "telegram",
      turnId: "turn-pre-delivery",
      messageId: "msg-pre-delivery",
      turnEventType: "delivery.sent",
      status: "sent",
    });
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.summary.channelTurns?.tools).toMatchObject({
      called: 1,
      results: 1,
      slowResults: 1,
      preDeliveryCalls: 1,
      slowPreDeliveryResults: 1,
      byTool: {
        home_assistant: {
          called: 1,
          results: 1,
          slowResults: 1,
          preDeliveryCalls: 1,
          slowPreDeliveryResults: 1,
          maxDurationMs: 18_000,
        },
      },
      recentPreDeliverySlow: [
        expect.objectContaining({
          channel: "telegram",
          turnId: "turn-pre-delivery",
          toolName: "home_assistant",
          durationMs: 18_000,
        }),
      ],
    });
    expect(snapshot.summary.channelTurns?.health.issues.map((issue) => issue.code)).toEqual([
      "slow_tool_result",
      "slow_tool_before_visible_delivery",
    ]);
    expect(snapshot.summary.controlLane).toMatchObject({
      status: "warning",
      reasons: ["slow_pre_delivery_tool"],
      slowPreDeliveryTools: 1,
    });
    expect(snapshot.summary.recommendations).toEqual([
      expect.objectContaining({
        code: "send_early_ack",
        priority: "high",
        source: "channel_turns",
        reason: "slow_tool_before_visible_delivery",
        metric: "slowPreDeliveryResults",
        count: 1,
      }),
    ]);
  });

  it("computes channel turn latency percentiles across samples", async () => {
    startDiagnosticStabilityRecorder();

    for (const [index, valueMs] of [100, 200, 300, 400, 500].entries()) {
      emitDiagnosticEvent({
        type: "channel.turn.event",
        channel: "telegram",
        turnId: `turn-${index}`,
        turnEventType: "turn.started",
        receivedToTurnStartMs: valueMs,
      });
    }
    await waitForDiagnosticEventsDrained();

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.summary.channelTurns?.latency?.receivedToTurnStartMs).toMatchObject({
      count: 5,
      slowCount: 0,
      latestMs: 500,
      maxMs: 500,
      p50Ms: 300,
      p90Ms: 500,
      p95Ms: 500,
    });
    expect(snapshot.summary.channelTurns?.latency?.bottleneck).toEqual({
      phase: "queue",
      metric: "receivedToTurnStartMs",
      maxMs: 500,
      slowCount: 0,
      count: 5,
    });
  });

  it("keeps the newest events when capacity is exceeded", () => {
    startDiagnosticStabilityRecorder();

    for (let index = 0; index < 1005; index += 1) {
      emitDiagnosticEvent({
        type: "message.queued",
        source: "test",
        queueDepth: index,
      });
    }

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 1000 });

    expect(snapshot.capacity).toBe(1000);
    expect(snapshot.count).toBe(1000);
    expect(snapshot.dropped).toBe(5);
    expect(snapshot.firstSeq).toBe(6);
    expect(snapshot.lastSeq).toBe(1005);
    expectFields(snapshot.events[0], { seq: 6, queueDepth: 5 });
  });

  it("filters snapshots by type, sequence, and limit", () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });
    emitDiagnosticEvent({ type: "payload.large", surface: "chat.history", action: "truncated" });
    emitDiagnosticEvent({ type: "payload.large", surface: "chat.history", action: "chunked" });

    const snapshot = getDiagnosticStabilitySnapshot({
      type: "payload.large",
      sinceSeq: 2,
      limit: 1,
    });

    expect(snapshot.count).toBe(1);
    expect(snapshot.events).toHaveLength(1);
    expectFields(snapshot.events[0], {
      seq: 3,
      type: "payload.large",
      action: "chunked",
    });
  });

  it("keeps async queue drop summaries after drained queued events for sinceSeq polling", async () => {
    startDiagnosticStabilityRecorder();

    for (let index = 0; index < 10_001; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `overflow-run-${index}`,
        callId: `overflow-call-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const midDrainSnapshot = getDiagnosticStabilitySnapshot({ limit: 1000 });
    expect(midDrainSnapshot.lastSeq).toBe(100);
    expect(
      midDrainSnapshot.events.some((event) => event.type === "diagnostic.async_queue.dropped"),
    ).toBe(false);

    await waitForDiagnosticEventsDrained();

    const sinceMidDrain = getDiagnosticStabilitySnapshot({
      sinceSeq: midDrainSnapshot.lastSeq,
      limit: 1000,
    });
    const dropSummary = sinceMidDrain.events.find(
      (event) => event.type === "diagnostic.async_queue.dropped",
    );
    expectFields(dropSummary, {
      type: "diagnostic.async_queue.dropped",
      droppedEvents: 1,
      droppedUntrustedEvents: 1,
      queueLength: 0,
      maxQueueLength: 10_000,
      drainBatchSize: 100,
    });
    expect(
      sinceMidDrain.events.filter((event) => event.type === "model.call.started"),
    ).not.toHaveLength(0);
    expect(sinceMidDrain.lastSeq).toBeGreaterThan(10_000);
  });

  it("applies query filters to persisted snapshots without mutating the source", () => {
    const snapshot: DiagnosticStabilitySnapshot = {
      generatedAt: "2026-04-22T12:00:00.000Z",
      capacity: 1000,
      count: 3,
      dropped: 0,
      firstSeq: 1,
      lastSeq: 3,
      events: [
        { seq: 1, ts: 1, type: "webhook.received" },
        { seq: 2, ts: 2, type: "payload.large", surface: "chat.history", action: "rejected" },
        { seq: 3, ts: 3, type: "payload.large", surface: "chat.history", action: "chunked" },
      ],
      summary: {
        byType: {
          "webhook.received": 1,
          "payload.large": 2,
        },
      },
    };

    const selected = selectDiagnosticStabilitySnapshot(snapshot, {
      type: "payload.large",
      limit: 1,
    });

    expectFields(selected, {
      count: 2,
      firstSeq: 2,
      lastSeq: 3,
    });
    expect(selected.events).toHaveLength(1);
    expectFields(selected.events[0], {
      seq: 3,
      type: "payload.large",
      action: "chunked",
    });
    expectFields(selected.summary.byType, {
      "payload.large": 2,
    });
    expectFields(selected.summary.payloadLarge, {
      count: 2,
      rejected: 1,
      chunked: 1,
    });
    expect(snapshot.events).toHaveLength(3);
  });

  it("normalizes external stability query params consistently", () => {
    expect(
      normalizeDiagnosticStabilityQuery(
        {
          limit: "25",
          type: " payload.large ",
          sinceSeq: "2",
        },
        { defaultLimit: 10 },
      ),
    ).toEqual({
      limit: 25,
      type: "payload.large",
      sinceSeq: 2,
    });
    expect(normalizeDiagnosticStabilityQuery({}, { defaultLimit: 10 })).toEqual({
      limit: 10,
      type: undefined,
      sinceSeq: undefined,
    });
    expect(() => normalizeDiagnosticStabilityQuery({ limit: 0 })).toThrow(
      "limit must be between 1 and 1000",
    );
    expect(() => normalizeDiagnosticStabilityQuery({ sinceSeq: -1 })).toThrow(
      "sinceSeq must be a non-negative integer",
    );
  });
});
