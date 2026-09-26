import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import { clearRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  onAgentEvent as subscribeAgentEvent,
  type AgentEventPayload,
} from "../../infra/agent-events.js";
import {
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
  type ReplyPayload,
} from "../reply-payload.js";
import {
  rootDir,
  runEmbeddedAgentMock,
  setupAgentRunnerTestHooks,
  tempDirs,
  warnPrivateFinalSpy,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import {
  createTestQueueSettings,
  createTestQueuedFollowupRun,
  createTestTemplateContext,
} from "./agent-runner.test-fixtures.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { createMockTypingController } from "./test-helpers.js";

// Hoist mocks before static dependencies, but defer the runner to avoid incomplete cyclic exports.
await vi.hoisted(async () => {
  await import("./agent-runner.misc.runreplyagent.test-support.js");
});
const { runReplyAgent } = await import("./agent-runner.js");

setupAgentRunnerTestHooks();

describe("runReplyAgent private message_tool_only final warning (#85714)", () => {
  const strandedDiagnosticText =
    "I generated a reply but could not deliver it to this chat. Please try again.";

  function normalizeReplyPayloads(
    result: Awaited<ReturnType<typeof runReplyAgent>>,
  ): ReplyPayload[] {
    return result === undefined ? [] : Array.isArray(result) ? result : [result];
  }

  function expectNoRecovery() {
    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
  }

  function expectSanitizedDiagnostic(result: Awaited<ReturnType<typeof runReplyAgent>>) {
    const payloads = normalizeReplyPayloads(result);
    const diagnostic = payloads.find((payload) => payload.text === strandedDiagnosticText);
    expect(diagnostic).toMatchObject({ isError: true, isStatusNotice: true });
    expect(getReplyPayloadMetadata(diagnostic ?? {})?.deliverDespiteSourceReplySuppression).toBe(
      true,
    );
    return payloads;
  }

  function expectPrivateOriginal(payloads: ReplyPayload[], text: string) {
    const original = payloads.find((payload) => payload.text === text);
    expect(original).toBeDefined();
    expect(getReplyPayloadMetadata(original ?? {})?.deliverDespiteSourceReplySuppression).not.toBe(
      true,
    );
  }

  async function runPrivateFinalCase(params: {
    messagingToolSentTargets?: unknown[];
    messagingToolSourceReplyPayloads?: Array<{ text?: string }>;
    didDeliverSourceReplyViaMessageTool?: boolean;
    finalAssistantText?: string;
    finalAssistantRawText?: string;
    stopReason?: string;
    payloads?: ReplyPayload[];
    payloadText?: string;
    successfulCronAdds?: number;
    inboundEventKind?: InboundEventKind;
    transcriptPrompt?: string;
    summaryLine?: string;
    strandedReplyRetry?: boolean;
    sendPolicyDenied?: boolean;
    isHeartbeat?: boolean;
    terminalReplyExpectation?: "required" | "optional";
    pendingContinuation?: boolean;
    onDeliberateSilentTerminalReply?: () => void;
    onObservedReplyDelivery?: () => Promise<void> | void;
    replyOperation?: ReturnType<typeof createReplyOperation>;
  }) {
    const tmp = tempDirs.make("openclaw-stranded-");
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "stranded";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1_000,
      ...(params.sendPolicyDenied ? { sendPolicy: "deny" as const } : {}),
    };
    await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);

    const finalAssistantText =
      params.finalAssistantText ??
      "Here is the answer the user asked for. It includes enough detail to read like a user-facing response rather than a short private note. This should have been sent with the message tool if the channel expected a visible reply.";
    runEmbeddedAgentMock.mockResolvedValue({
      // Metadata payloads must not be mistaken for the assistant's final text.
      payloads: params.payloads ?? [{ text: params.payloadText ?? finalAssistantText }],
      meta: {
        agentMeta: {},
        finalAssistantVisibleText: finalAssistantText,
        stopReason: params.stopReason,
        yielded: params.pendingContinuation,
        finalAssistantRawText: params.finalAssistantRawText,
      },
      messagingToolSentTargets: params.messagingToolSentTargets,
      messagingToolSourceReplyPayloads: params.messagingToolSourceReplyPayloads,
      didDeliverSourceReplyViaMessageTool: params.didDeliverSourceReplyViaMessageTool,
      successfulCronAdds: params.successfulCronAdds,
    });

    const sessionCtx = createTestTemplateContext({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "+15550001111",
      AccountId: "primary",
      MessageSid: "msg",
      ChatType: "direct",
      InboundEventKind: params.inboundEventKind,
    });
    const followupRun = createTestQueuedFollowupRun({
      prompt: "hello",
      summaryLine: params.summaryLine ?? "hello",
      strandedReplyRetry: params.strandedReplyRetry,
      enqueuedAt: Date.now(),
      transcriptPrompt: params.transcriptPrompt,
      run: {
        agentId: "main",
        agentDir: path.join(rootDir, "agent"),
        sessionId: "session",
        sessionKey,
        messageProvider: "whatsapp",
        sessionFile: path.join(rootDir, "session.jsonl"),
        workspaceDir: tmp,
        // Carry the canonical tool-only run fact and keep downstream policy aligned,
        // so the private final is never eligible for automatic source delivery.
        config: { messages: { visibleReplies: "message_tool" } },
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        thinkingCatalog: [{ provider: "anthropic", id: "claude", input: ["text"] }],
        thinkLevel: "low",
        reasoningLevel: "on",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
        sourceReplyDeliveryMode: "message_tool_only",
        terminalReplyExpectation:
          params.terminalReplyExpectation ??
          (params.isHeartbeat || params.inboundEventKind === "room_event"
            ? "optional"
            : "required"),
      },
    });

    // Session seeding pins an empty runtime snapshot that would override visibleReplies.
    clearRuntimeConfigSnapshot();

    const runId = `stranded-${path.basename(tmp)}`;
    const agentEvents: AgentEventPayload[] = [];
    const unsubscribe = subscribeAgentEvent((event) => {
      if (event.runId === runId) {
        agentEvents.push(event);
      }
    });
    try {
      const result = await runReplyAgent({
        commandBody: "hello",
        followupRun,
        queueKey: sessionKey,
        resolvedQueue: createTestQueueSettings({ mode: "interrupt" }),
        shouldSteer: false,
        shouldFollowup: false,
        isActive: false,
        typing: createMockTypingController(),
        sessionCtx,
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
        storePath,
        defaultModel: "anthropic/claude-opus-4-6",
        resolvedVerboseLevel: "off",
        isNewSession: false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: "instant",
        opts: {
          runId,
          isHeartbeat: params.isHeartbeat,
          onDeliberateSilentTerminalReply: params.onDeliberateSilentTerminalReply,
          onObservedReplyDelivery: params.onObservedReplyDelivery,
        },
        replyOperation: params.replyOperation,
      });
      const terminalEvent = agentEvents.find(
        (event) =>
          event.stream === "lifecycle" &&
          (event.data.phase === "end" || event.data.phase === "error"),
      );
      return { result, finalAssistantText, terminalEvent };
    } finally {
      unsubscribe();
    }
  }

  it("uses visible final text, not raw assistant text, in the recovery retry prompt", async () => {
    const visibleFinal =
      "Visible answer that has already been normalized for the user-facing final response and is long enough to trigger recovery. It includes a second complete sentence so the substantive-final detector treats it as a real reply.";
    await runPrivateFinalCase({
      finalAssistantText: visibleFinal,
      finalAssistantRawText: `<final>${visibleFinal}</final>`,
    });

    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    const retryRun = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
    expect(retryRun?.prompt).toContain(visibleFinal);
    expect(retryRun?.prompt).not.toContain("<final>");
  });

  it("uses normalized delivery text, not reply directive tags, in the recovery retry prompt", async () => {
    const normalizedFinal =
      "Visible answer that should be threaded to the current message and is long enough to trigger recovery. It includes another complete sentence so the substantive-final detector treats it as a real reply.";
    await runPrivateFinalCase({
      finalAssistantText: `[[reply_to_current]] ${normalizedFinal}`,
      payloadText: `[[reply_to_current]] ${normalizedFinal}`,
    });

    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    const retryRun = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
    expect(retryRun?.prompt).toContain(normalizedFinal);
    expect(retryRun?.prompt).not.toContain("[[reply_to_current]]");
  });

  it("excludes raw trace and status payloads from the recovery retry prompt", async () => {
    const visibleFinal =
      "Visible answer that should be delivered to the source chat. It includes another complete sentence so the substantive-final detector treats it as a real reply.";
    const rawTraceText =
      "🔎 Model Input (User Role):\n```text\nsecret user trace that must not reach chat\n```";
    const statusText = "🧩 Active Memory: status=ok query=private-context";
    await runPrivateFinalCase({
      finalAssistantText: visibleFinal,
      payloads: [
        { text: visibleFinal },
        { text: rawTraceText },
        { text: statusText, isStatusNotice: true },
      ],
    });

    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    const retryRun = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
    expect(retryRun?.prompt).toContain(visibleFinal);
    expect(retryRun?.prompt).not.toContain("secret user trace");
    expect(retryRun?.prompt).not.toContain("Active Memory");
  });

  it("suppresses retry prompt persistence and keeps the retry out of collect batches", async () => {
    await runPrivateFinalCase({ transcriptPrompt: "original user question" });

    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(warnPrivateFinalSpy.mock.calls[0]?.[0]).toMatchObject({ sessionKey: "stranded" });
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    const retryRun = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
    expect(retryRun?.transcriptPrompt).toBeUndefined();
    expect(retryRun?.userTurnTranscriptRecorder).toBeUndefined();
    expect(retryRun?.currentInboundContext).toBeUndefined();
    expect(retryRun?.run?.suppressNextUserMessagePersistence).toBe(true);
    expect(retryRun?.run?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(retryRun?.disableCollectBatching).toBe(true);
    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[3]).toBe("none");
    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[5]).toBe(false);
    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[6]).toEqual({ position: "front" });
  });

  it("records a short private final without a message call as non-delivery", async () => {
    const { terminalEvent } = await runPrivateFinalCase({
      finalAssistantText: "Nothing to send here.",
    });
    expect(terminalEvent?.data.terminalReply).toEqual({
      disposition: "empty",
      code: "message-tool-not-called",
    });
    expectNoRecovery();
  });

  it("attests source delivery without warning or retry when the message tool delivered this turn", async () => {
    const onObservedReplyDelivery = vi.fn(async () => {});
    const { terminalEvent, finalAssistantText } = await runPrivateFinalCase({
      didDeliverSourceReplyViaMessageTool: true,
      onObservedReplyDelivery,
    });
    expect(terminalEvent?.data.terminalReply).toEqual({
      disposition: "visible",
      text: finalAssistantText,
    });
    expect(onObservedReplyDelivery).toHaveBeenCalledTimes(1);
    expectNoRecovery();
  });

  it("does not record message-tool non-delivery while the run has a continuation", async () => {
    const { terminalEvent } = await runPrivateFinalCase({
      finalAssistantText: "Nothing to send here.",
      pendingContinuation: true,
    });
    expect((terminalEvent?.data.terminalReply as { code?: unknown } | undefined)?.code).not.toBe(
      "message-tool-not-called",
    );
  });

  it("still recovers a private final after only a message-tool progress delivery", async () => {
    const onObservedReplyDelivery = vi.fn(async () => {});
    await runPrivateFinalCase({
      onObservedReplyDelivery,
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "whatsapp",
          to: "+15550001111",
          text: "Working on it.",
          sourceReplyFinal: false,
        },
      ],
    });

    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(onObservedReplyDelivery).not.toHaveBeenCalled();
  });

  it("does not recover again after an explicit final message-tool delivery", async () => {
    await runPrivateFinalCase({
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "whatsapp",
          to: "+15550001111",
          sourceReplyFinal: true,
        },
      ],
    });

    expectNoRecovery();
  });

  it("does not recover a source-owned retry terminal reply before delivery", async () => {
    const text =
      "The requested action completed once. This recovered answer contains the result of the completed work and is ready for delivery to the original conversation. No completed action needs to run again.";
    const { result } = await runPrivateFinalCase({
      finalAssistantText: text,
      payloads: [markReplyPayloadForSourceSuppressionDelivery({ text })],
      strandedReplyRetry: true,
    });

    const payloads = normalizeReplyPayloads(result);
    expect(payloads).toEqual([expect.objectContaining({ text })]);
    const [payload] = payloads;
    assert(payload);
    expect(getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
  });

  it("surfaces a canonical failure despite a private partial reply", async () => {
    const privateText =
      "Private partial output before the provider failed. These internal notes describe unfinished work and must stay private. They are not a completed answer or a substitute for the terminal failure.";
    const { result } = await runPrivateFinalCase({
      finalAssistantText: privateText,
      stopReason: "error",
    });

    const deliverable = normalizeReplyPayloads(result).filter(
      (payload) => getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true,
    );
    expect(deliverable).toEqual([expect.objectContaining({ isError: true })]);
    expect(deliverable[0]?.text).not.toBe(privateText);
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
  });

  it("still retries when the message tool sent only to a non-source target", async () => {
    await runPrivateFinalCase({
      messagingToolSentTargets: [{ tool: "message", provider: "whatsapp", to: "+15559998888" }],
    });
    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
  });

  it("still retries when only an unrelated cron side effect succeeded", async () => {
    await runPrivateFinalCase({ successfulCronAdds: 1 });
    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
  });

  it.each(["required", "optional"] as const)(
    "accounts for a %s NO_REPLY turn when metadata payloads remain",
    async (terminalReplyExpectation) => {
      const onDeliberateSilentTerminalReply = vi.fn();
      const { result } = await runPrivateFinalCase({
        terminalReplyExpectation,
        finalAssistantText: "NO_REPLY",
        finalAssistantRawText: "NO_REPLY",
        onDeliberateSilentTerminalReply,
        payloads: [{ text: "Auto-compaction complete (count 1).", isStatusNotice: true }],
      });
      const payloads = normalizeReplyPayloads(result);
      const failures = payloads.filter((payload) => payload.isError === true);
      if (terminalReplyExpectation === "required") {
        expect(failures).toEqual([expect.objectContaining({ text: expect.any(String) })]);
        expect(onDeliberateSilentTerminalReply).not.toHaveBeenCalled();
      } else {
        expect(failures).toEqual([]);
        expect(onDeliberateSilentTerminalReply).toHaveBeenCalledOnce();
      }
      expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
      expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    },
  );

  it("does not warn or enqueue retry for room_event turns", async () => {
    const { terminalEvent } = await runPrivateFinalCase({ inboundEventKind: "room_event" });
    expect((terminalEvent?.data.terminalReply as { code?: unknown } | undefined)?.code).not.toBe(
      "message-tool-not-called",
    );
    expectNoRecovery();
  });

  it("does not warn, enqueue retry, or emit diagnostic for heartbeat runs", async () => {
    const { result, terminalEvent } = await runPrivateFinalCase({ isHeartbeat: true });
    expect((terminalEvent?.data.terminalReply as { code?: unknown } | undefined)?.code).not.toBe(
      "message-tool-not-called",
    );
    expectNoRecovery();
    const payloads = normalizeReplyPayloads(result);
    expect(payloads.some((payload) => payload.text === strandedDiagnosticText)).toBe(false);
  });

  it("does not warn or enqueue retry when send policy denied source delivery", async () => {
    const { terminalEvent } = await runPrivateFinalCase({ sendPolicyDenied: true });
    expect((terminalEvent?.data.terminalReply as { code?: unknown } | undefined)?.code).not.toBe(
      "message-tool-not-called",
    );
    expectNoRecovery();
  });

  it("does not enqueue a second retry when a stranded-reply retry strands again", async () => {
    const { result, finalAssistantText } = await runPrivateFinalCase({
      summaryLine: "stranded-reply-retry",
      strandedReplyRetry: true,
    });

    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    expectPrivateOriginal(expectSanitizedDiagnostic(result), finalAssistantText);
  });

  it("does not treat user-controlled summary text as the internal retry marker", async () => {
    await runPrivateFinalCase({
      summaryLine: "stranded-reply-retry",
    });

    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
  });

  it("does not emit retry-failure diagnostic after internal source reply delivery", async () => {
    const { result } = await runPrivateFinalCase({
      summaryLine: "stranded-reply-retry",
      strandedReplyRetry: true,
      messagingToolSourceReplyPayloads: [{ text: "visible recovered reply" }],
      finalAssistantText: "",
      payloadText: "",
    });

    const payloads = normalizeReplyPayloads(result);
    expect(payloads.some((payload) => payload.text === strandedDiagnosticText)).toBe(false);
  });

  it("emits the sanitized diagnostic when a stranded-reply retry produces no source delivery", async () => {
    const { result } = await runPrivateFinalCase({
      summaryLine: "stranded-reply-retry",
      strandedReplyRetry: true,
      finalAssistantText: "",
      payloadText: "",
    });

    expectNoRecovery();
    expectSanitizedDiagnostic(result);
  });

  it("emits the same sanitized diagnostic when the retry cannot be enqueued", async () => {
    vi.mocked(enqueueFollowupRun).mockResolvedValueOnce(false);

    const { result, finalAssistantText } = await runPrivateFinalCase({});

    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expectPrivateOriginal(expectSanitizedDiagnostic(result), finalAssistantText);
  });

  it("schedules the stranded-reply retry drain only after the active reply operation clears", async () => {
    const sessionKey = "stranded";
    const replyOperation = createReplyOperation({
      sessionKey,
      sessionId: "session",
      resetTriggered: false,
    });
    vi.mocked(enqueueFollowupRun).mockResolvedValueOnce(true);

    vi.mocked(scheduleFollowupDrain).mockImplementation((key) => {
      expect(key).toBe(sessionKey);
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
    });

    await runPrivateFinalCase({ replyOperation });

    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(replyRunRegistry.get(sessionKey)).toBe(replyOperation);
    expect(scheduleFollowupDrain).not.toHaveBeenCalled();

    replyOperation.complete();

    expect(scheduleFollowupDrain).toHaveBeenCalledTimes(1);
  });
});
