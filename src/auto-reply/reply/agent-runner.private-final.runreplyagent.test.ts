import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
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
import type { VerboseLevel } from "../thinking.shared.js";
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
import type { FollowupRun } from "./queue.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { createMockTypingController } from "./test-helpers.js";

const requireRecord = createRequireRecord("record", "expected-label-object");

// Hoist mocks before static dependencies, but defer the runner to avoid incomplete cyclic exports.
await vi.hoisted(async () => {
  await import("./agent-runner.misc.runreplyagent.test-support.js");
});
const { runReplyAgent } = await import("./agent-runner.js");

setupAgentRunnerTestHooks();

describe("runReplyAgent private message_tool_only final warning (#85714)", () => {
  const strandedDiagnosticText =
    "I generated a reply but could not deliver it to this chat. Please try again.";

  function normalizeReplyPayloads(result: unknown): Record<string, unknown>[] {
    const payloads = Array.isArray(result) ? result : [result];
    return payloads.map((payload, index) => requireRecord(payload, `reply payload ${index}`));
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
    resolvedVerboseLevel?: VerboseLevel;
    isNewSession?: boolean;
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
    turnAdoptionLifecycle?: FollowupRun["turnAdoptionLifecycle"];
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
      // payloadText can differ from the assistant text to simulate metadata-only
      // payloads (verbose notices, usage line) that must NOT trigger the warn —
      // detection keys off the assistant final text, not the payload bundle.
      payloads: params.payloads ?? [{ text: params.payloadText ?? finalAssistantText }],
      meta: {
        agentMeta: {},
        finalAssistantVisibleText: finalAssistantText,
        ...(params.stopReason ? { stopReason: params.stopReason } : {}),
        ...(params.pendingContinuation ? { yielded: true } : {}),
        ...(params.finalAssistantRawText
          ? { finalAssistantRawText: params.finalAssistantRawText }
          : {}),
      },
      ...(params.messagingToolSentTargets
        ? { messagingToolSentTargets: params.messagingToolSentTargets }
        : {}),
      ...(params.messagingToolSourceReplyPayloads
        ? { messagingToolSourceReplyPayloads: params.messagingToolSourceReplyPayloads }
        : {}),
      ...(params.didDeliverSourceReplyViaMessageTool
        ? { didDeliverSourceReplyViaMessageTool: true }
        : {}),
      ...(params.successfulCronAdds === undefined
        ? {}
        : { successfulCronAdds: params.successfulCronAdds }),
    });

    const sessionCtx = createTestTemplateContext({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "+15550001111",
      AccountId: "primary",
      MessageSid: "msg",
      ChatType: "direct",
      ...(params.inboundEventKind ? { InboundEventKind: params.inboundEventKind } : {}),
    });
    const followupRun = createTestQueuedFollowupRun({
      prompt: "hello",
      summaryLine: params.summaryLine ?? "hello",
      ...(params.strandedReplyRetry ? { strandedReplyRetry: true } : {}),
      enqueuedAt: Date.now(),
      ...(params.transcriptPrompt ? { transcriptPrompt: params.transcriptPrompt } : {}),
      ...(params.turnAdoptionLifecycle
        ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
        : {}),
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

    // Seeding the SQLite session entry above resolves the runtime config
    // (getRuntimeConfig) and pins an empty `{}` snapshot; leaving it in place
    // would make resolveQueuedReplyExecutionConfig override the run's
    // visibleReplies=message_tool config and mis-resolve delivery to automatic.
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
        resolvedVerboseLevel: params.resolvedVerboseLevel ?? "off",
        isNewSession: params.isNewSession ?? false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: "instant",
        opts: {
          runId,
          ...(params.isHeartbeat ? { isHeartbeat: true } : {}),
          ...(params.onDeliberateSilentTerminalReply
            ? { onDeliberateSilentTerminalReply: params.onDeliberateSilentTerminalReply }
            : {}),
          ...(params.onObservedReplyDelivery
            ? { onObservedReplyDelivery: params.onObservedReplyDelivery }
            : {}),
        },
        ...(params.replyOperation ? { replyOperation: params.replyOperation } : {}),
      });
      const terminalEvent = agentEvents.find(
        (event) =>
          event.stream === "lifecycle" &&
          (event.data.phase === "end" || event.data.phase === "error"),
      );
      return { storePath, tmp, sessionKey, result, finalAssistantText, terminalEvent };
    } finally {
      unsubscribe();
    }
  }

  it("warns when a substantive private final reply never used the message tool", async () => {
    await runPrivateFinalCase({});
    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(warnPrivateFinalSpy.mock.calls[0]?.[0]).toMatchObject({ sessionKey: "stranded" });
  });

  it("attests observed delivery for message-tool source replies outside message_tool_only", async () => {
    // A source-routed message-tool answer plus NO_REPLY must not draw the
    // no-visible-reply fallback into the source conversation (#114799).
    const onObservedReplyDelivery = vi.fn(async () => {});
    await runPrivateFinalCase({
      didDeliverSourceReplyViaMessageTool: true,
      onObservedReplyDelivery,
    });
    expect(onObservedReplyDelivery).toHaveBeenCalledTimes(1);
  });

  it("enqueues a one-shot recovery retry by default for substantive stranded finals", async () => {
    const parentOnComplete = vi.fn();
    const parentLifecycle = { onAdopted: async () => {}, onSettled: parentOnComplete };
    const { finalAssistantText } = await runPrivateFinalCase({
      turnAdoptionLifecycle: parentLifecycle,
    });

    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    const retryRun = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
    const messagesConfig = retryRun?.run?.config?.messages as Record<string, unknown> | undefined;
    expect(messagesConfig).toEqual({ visibleReplies: "message_tool" });
    expect(retryRun?.summaryLine).toBe("stranded-reply-retry");
    expect(retryRun?.strandedReplyRetry).toBe(true);
    expect(retryRun?.prompt).toContain("message(action=send)");
    expect(retryRun?.prompt).toContain(finalAssistantText);
    // System retry must not inherit the client turn's one-shot lifecycle identity.
    expect(retryRun?.turnAdoptionLifecycle).toBeUndefined();
    expect(parentLifecycle.onSettled).toBe(parentOnComplete);
    expect(parentOnComplete).not.toHaveBeenCalled();
  });

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
    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
  });

  it("does not warn or enqueue retry when the message tool delivered this turn", async () => {
    const { terminalEvent, finalAssistantText } = await runPrivateFinalCase({
      didDeliverSourceReplyViaMessageTool: true,
    });
    expect(terminalEvent?.data.terminalReply).toEqual({
      disposition: "visible",
      text: finalAssistantText,
    });
    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
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

    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not recover a source-owned terminal reply before delivery (retry=%s)",
    async (strandedReplyRetry) => {
      const text =
        "The requested action completed once. This recovered answer contains the result of the completed work and is ready for delivery to the original conversation. No completed action needs to run again.";
      const { result } = await runPrivateFinalCase({
        finalAssistantText: text,
        payloads: [markReplyPayloadForSourceSuppressionDelivery({ text })],
        strandedReplyRetry,
      });

      const payloads = normalizeReplyPayloads(result);
      expect(payloads).toEqual([expect.objectContaining({ text })]);
      const [payload] = payloads;
      assert(payload);
      expect(getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression).toBe(true);
      expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    },
  );

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
      const payloads = result === undefined ? [] : normalizeReplyPayloads(result);
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
    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
  });

  it("does not warn, enqueue retry, or emit diagnostic for heartbeat runs", async () => {
    const { result, terminalEvent } = await runPrivateFinalCase({ isHeartbeat: true });
    expect((terminalEvent?.data.terminalReply as { code?: unknown } | undefined)?.code).not.toBe(
      "message-tool-not-called",
    );
    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    const payloads = result === undefined ? [] : normalizeReplyPayloads(result);
    expect(payloads.some((payload) => payload.text === strandedDiagnosticText)).toBe(false);
  });

  it("does not warn or enqueue retry when send policy denied source delivery", async () => {
    const { terminalEvent } = await runPrivateFinalCase({ sendPolicyDenied: true });
    expect((terminalEvent?.data.terminalReply as { code?: unknown } | undefined)?.code).not.toBe(
      "message-tool-not-called",
    );
    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
  });

  it("does not enqueue a second retry when a stranded-reply retry strands again", async () => {
    const { result, finalAssistantText } = await runPrivateFinalCase({
      summaryLine: "stranded-reply-retry",
      strandedReplyRetry: true,
    });

    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    const payloads = normalizeReplyPayloads(result);
    const original = payloads.find((payload) => payload.text === finalAssistantText);
    const diagnostic = payloads.find((payload) => payload.text === strandedDiagnosticText);
    expect(original).toBeDefined();
    expect(getReplyPayloadMetadata(original ?? {})?.deliverDespiteSourceReplySuppression).not.toBe(
      true,
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.isError).toBe(true);
    expect(diagnostic?.isStatusNotice).toBe(true);
    expect(getReplyPayloadMetadata(diagnostic ?? {})?.deliverDespiteSourceReplySuppression).toBe(
      true,
    );
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

    const payloads = result === undefined ? [] : normalizeReplyPayloads(result);
    expect(payloads.some((payload) => payload.text === strandedDiagnosticText)).toBe(false);
  });

  it("emits the sanitized diagnostic when a stranded-reply retry produces no source delivery", async () => {
    const { result } = await runPrivateFinalCase({
      summaryLine: "stranded-reply-retry",
      strandedReplyRetry: true,
      finalAssistantText: "",
      payloadText: "",
    });

    expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    const payloads = normalizeReplyPayloads(result);
    const diagnostic = payloads.find((payload) => payload.text === strandedDiagnosticText);
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.isError).toBe(true);
    expect(diagnostic?.isStatusNotice).toBe(true);
    expect(getReplyPayloadMetadata(diagnostic ?? {})?.deliverDespiteSourceReplySuppression).toBe(
      true,
    );
  });

  it("emits the same sanitized diagnostic when the retry cannot be enqueued", async () => {
    vi.mocked(enqueueFollowupRun).mockReturnValueOnce(false);

    const { result, finalAssistantText } = await runPrivateFinalCase({});

    expect(warnPrivateFinalSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    const payloads = normalizeReplyPayloads(result);
    const original = payloads.find((payload) => payload.text === finalAssistantText);
    const diagnostic = payloads.find((payload) => payload.text === strandedDiagnosticText);
    expect(original).toBeDefined();
    expect(getReplyPayloadMetadata(original ?? {})?.deliverDespiteSourceReplySuppression).not.toBe(
      true,
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.isError).toBe(true);
    expect(diagnostic?.isStatusNotice).toBe(true);
    expect(getReplyPayloadMetadata(diagnostic ?? {})?.deliverDespiteSourceReplySuppression).toBe(
      true,
    );
  });

  it("schedules the stranded-reply retry drain only after the active reply operation clears", async () => {
    const sessionKey = "stranded";
    const replyOperation = createReplyOperation({
      sessionKey,
      sessionId: "session",
      resetTriggered: false,
    });
    vi.mocked(enqueueFollowupRun).mockReturnValueOnce(true);

    const drainOrder: string[] = [];
    vi.mocked(scheduleFollowupDrain).mockImplementation((key) => {
      expect(key).toBe(sessionKey);
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
      drainOrder.push("drain");
    });

    await runPrivateFinalCase({ replyOperation });

    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(replyRunRegistry.get(sessionKey)).toBe(replyOperation);
    expect(scheduleFollowupDrain).not.toHaveBeenCalled();

    drainOrder.push("clear");
    replyOperation.complete();

    expect(drainOrder[0]).toBe("clear");
    expect(scheduleFollowupDrain).toHaveBeenCalledTimes(1);
  });
});
