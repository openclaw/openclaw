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

  const visibleFinal =
    "Visible answer that should be delivered to the source chat. It includes another complete sentence so the substantive-final detector treats it as a real reply.";
  it.each([
    {
      name: "raw final tags",
      params: {
        finalAssistantText: visibleFinal,
        finalAssistantRawText: `<final>${visibleFinal}</final>`,
      },
      excluded: ["<final>"],
    },
    {
      name: "reply directives",
      params: {
        finalAssistantText: `[[reply_to_current]] ${visibleFinal}`,
        payloadText: `[[reply_to_current]] ${visibleFinal}`,
      },
      excluded: ["[[reply_to_current]]"],
    },
    {
      name: "trace and status payloads",
      params: {
        finalAssistantText: visibleFinal,
        payloads: [
          { text: visibleFinal },
          {
            text: "🔎 Model Input (User Role):\n```text\nsecret user trace that must not reach chat\n```",
          },
          { text: "🧩 Active Memory: status=ok query=private-context", isStatusNotice: true },
        ],
      },
      excluded: ["secret user trace", "Active Memory"],
    },
  ])("excludes $name from the recovery prompt", async ({ params, excluded }) => {
    await runPrivateFinalCase(params);
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    const retryRun = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
    expect(retryRun?.prompt).toContain(visibleFinal);
    for (const text of excluded) {
      expect(retryRun?.prompt).not.toContain(text);
    }
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

  it.each([false, true])(
    "accounts for short private finals with continuation=%s",
    async (pendingContinuation) => {
      const { terminalEvent } = await runPrivateFinalCase({
        finalAssistantText: "Nothing to send here.",
        pendingContinuation,
      });
      if (pendingContinuation) {
        expect(
          (terminalEvent?.data.terminalReply as { code?: unknown } | undefined)?.code,
        ).not.toBe("message-tool-not-called");
      } else {
        expect(terminalEvent?.data.terminalReply).toEqual({
          disposition: "empty",
          code: "message-tool-not-called",
        });
        expectNoRecovery();
      }
    },
  );

  it.each([undefined, false, true])(
    "attests only terminal source delivery (sourceReplyFinal=%s)",
    async (sourceReplyFinal) => {
      const onObservedReplyDelivery = vi.fn(async () => {});
      const { terminalEvent, finalAssistantText } = await runPrivateFinalCase({
        didDeliverSourceReplyViaMessageTool: true,
        onObservedReplyDelivery,
        messagingToolSentTargets:
          sourceReplyFinal === undefined
            ? undefined
            : [
                {
                  tool: "message",
                  provider: "whatsapp",
                  to: "+15550001111",
                  sourceReplyFinal,
                  ...(sourceReplyFinal ? {} : { text: "Working on it." }),
                },
              ],
      });
      if (sourceReplyFinal === false) {
        expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
        expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
        expect(onObservedReplyDelivery).not.toHaveBeenCalled();
      } else {
        expectNoRecovery();
        if (sourceReplyFinal === undefined) {
          expect(terminalEvent?.data.terminalReply).toEqual({
            disposition: "visible",
            text: finalAssistantText,
          });
          expect(onObservedReplyDelivery).toHaveBeenCalledTimes(1);
        }
      }
    },
  );

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

  it.each([
    {
      name: "non-source message",
      params: {
        messagingToolSentTargets: [{ tool: "message", provider: "whatsapp", to: "+15559998888" }],
      },
    },
    { name: "cron side effect", params: { successfulCronAdds: 1 } },
    { name: "user-controlled retry marker", params: { summaryLine: "stranded-reply-retry" } },
  ])("does not accept $name as source delivery or retry authority", async ({ params }) => {
    await runPrivateFinalCase(params);
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

  it.each([
    { name: "room event", params: { inboundEventKind: "room_event" } },
    { name: "heartbeat", params: { isHeartbeat: true } },
    { name: "denied send policy", params: { sendPolicyDenied: true } },
  ] satisfies Array<{ name: string; params: Parameters<typeof runPrivateFinalCase>[0] }>)(
    "does not recover a $name",
    async ({ params }) => {
      const { result, terminalEvent } = await runPrivateFinalCase(params);
      expect((terminalEvent?.data.terminalReply as { code?: unknown } | undefined)?.code).not.toBe(
        "message-tool-not-called",
      );
      expectNoRecovery();
      if (params.isHeartbeat) {
        expect(
          normalizeReplyPayloads(result).some((payload) => payload.text === strandedDiagnosticText),
        ).toBe(false);
      }
    },
  );

  it.each(["already retried", "enqueue rejected"] as const)(
    "diagnoses a private final when recovery is %s",
    async (failure) => {
      const retried = failure === "already retried";
      if (!retried) {
        vi.mocked(enqueueFollowupRun).mockReturnValueOnce(false);
      }
      const { result, finalAssistantText } = await runPrivateFinalCase(
        retried ? { summaryLine: "stranded-reply-retry", strandedReplyRetry: true } : {},
      );
      expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
      expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(retried ? 0 : 1);
      expectPrivateOriginal(expectSanitizedDiagnostic(result), finalAssistantText);
    },
  );

  it.each([false, true])(
    "diagnoses empty retry output only without source delivery (delivered=%s)",
    async (delivered) => {
      const { result } = await runPrivateFinalCase({
        summaryLine: "stranded-reply-retry",
        strandedReplyRetry: true,
        finalAssistantText: "",
        payloadText: "",
        messagingToolSourceReplyPayloads: delivered
          ? [{ text: "visible recovered reply" }]
          : undefined,
      });
      if (delivered) {
        expect(
          normalizeReplyPayloads(result).some((payload) => payload.text === strandedDiagnosticText),
        ).toBe(false);
      } else {
        expectNoRecovery();
        expectSanitizedDiagnostic(result);
      }
    },
  );

  it("schedules the stranded-reply retry drain only after the active reply operation clears", async () => {
    const sessionKey = "stranded";
    const replyOperation = createReplyOperation({
      sessionKey,
      sessionId: "session",
      resetTriggered: false,
    });
    vi.mocked(enqueueFollowupRun).mockReturnValueOnce(true);

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
