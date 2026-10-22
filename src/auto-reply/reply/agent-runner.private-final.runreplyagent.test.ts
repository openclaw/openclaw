import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { prepareAgentRunTerminalReply } from "../../agents/agent-run-terminal-reply.js";
import { hasCompletedSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { MISSING_REPLY_NOTICE_TEXT } from "../../agents/reply-completion.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  onAgentEvent as subscribeAgentEvent,
  type AgentEventPayload,
} from "../../infra/agent-events.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
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
import { createBaseRun } from "./agent-runner.runreplyagent.test-support.js";
import { createTestQueueSettings } from "./agent-runner.test-fixtures.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import {
  createAccounting,
  createDefaults,
  createSettledExecution,
  createTurn,
} from "./followup-delivery.test-helpers.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import type { FollowupRun } from "./queue/types.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { routeReply } from "./route-reply.js";
import type * as RouteReplyModule from "./route-reply.js";
import { buildTestCtx } from "./test-ctx.js";
import { createMockTypingController } from "./test-helpers.js";

// Hoist mocks before static dependencies, but defer the runner to avoid incomplete cyclic exports.
await vi.hoisted(async () => {
  await import("./agent-runner.misc.runreplyagent.test-support.js");
});
vi.mock("./route-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RouteReplyModule>()),
  routeReply: vi.fn(async () => ({ ok: true, delivered: true })),
}));
const { runReplyAgent } = await import("./agent-runner-run.js");
const { dispatchReplyFromConfig } = await import("./dispatch-from-config.js");

setupAgentRunnerTestHooks();

describe("runReplyAgent stranded message_tool_only finals (#85714)", () => {
  const strandedDiagnosticText = MISSING_REPLY_NOTICE_TEXT;

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
    expect(getReplyPayloadMetadata(diagnostic ?? {})).toMatchObject({
      assistantTranscriptOwned: true,
      deliverDespiteSourceReplySuppression: true,
    });
    return payloads;
  }

  async function runPrivateFinalCase(params: {
    messagingToolSentTargets?: unknown[];
    messagingToolSourceReplyPayloads?: Array<{ text?: string }>;
    didDeliverSourceReplyViaMessageTool?: boolean;
    finalAssistantText?: string;
    finalAssistantRawText?: string;
    stopReason?: string;
    payloads?: ReplyPayload[];
    successfulCronAdds?: number;
    inboundEventKind?: InboundEventKind;
    transcriptPrompt?: string;
    summaryLine?: string;
    strandedReplyRetry?: boolean;
    sendPolicyDenied?: boolean;
    chatType?: "direct" | "group";
    terminalReplyExpectation?: "required" | "optional";
    pendingContinuation?: boolean;
    implicitContinuation?: boolean;
    onDeliberateSilentTerminalReply?: () => void;
    onObservedReplyDelivery?: () => Promise<void> | void;
    onReplyOperationOwned?: (operation: ReplyOperation) => boolean | void;
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

    const finalAssistantText = params.finalAssistantText ?? "Done — deployed v2 to staging.";
    const createRunResult = (retryDelivered?: boolean, retryText?: string) => ({
      // Metadata payloads must not be mistaken for the assistant's final text.
      payloads:
        retryText === undefined
          ? (params.payloads ?? [{ text: finalAssistantText }])
          : [{ text: retryText }],
      meta: {
        agentMeta: {},
        finalAssistantVisibleText: retryText ?? finalAssistantText,
        stopReason: params.stopReason,
        yielded: params.pendingContinuation,
        continuationPending: params.implicitContinuation,
        finalAssistantRawText: retryText ?? params.finalAssistantRawText,
        terminalReply: prepareAgentRunTerminalReply({
          rawText: retryText ?? params.finalAssistantRawText ?? finalAssistantText,
        }).terminalReply,
      },
      messagingToolSentTargets: params.messagingToolSentTargets,
      messagingToolSourceReplyPayloads: retryDelivered
        ? [{ text: finalAssistantText }]
        : params.messagingToolSourceReplyPayloads,
      didDeliverSourceReplyViaMessageTool:
        retryDelivered ?? params.didDeliverSourceReplyViaMessageTool,
      successfulCronAdds: params.successfulCronAdds,
    });

    const { sessionCtx, followupRun } = createBaseRun({
      context: {
        Provider: "whatsapp",
        OriginatingChannel: "whatsapp",
        OriginatingTo: "+15550001111",
        AccountId: "primary",
        MessageSid: "msg",
        ChatType: params.chatType ?? "direct",
        InboundEventKind: params.inboundEventKind,
      },
      followup: {
        summaryLine: params.summaryLine ?? "hello",
        strandedReplyRetry: params.strandedReplyRetry,
        toolsAllow: ["message", "read"],
        transcriptPrompt: params.transcriptPrompt,
      },
      run: {
        agentId: "main",
        agentDir: path.join(rootDir, "agent"),
        sessionKey,
        workspaceDir: tmp,
        // Carry the canonical tool-only run fact and keep downstream policy aligned,
        // so the private final is never eligible for automatic source delivery.
        config: { session: { store: storePath }, messages: { visibleReplies: "message_tool" } },
        thinkingCatalog: [{ provider: "anthropic", id: "claude", input: ["text"] }],
        thinkLevel: "low",
        reasoningLevel: "on",
        sourceReplyDeliveryMode: "message_tool_only",
        extraSystemPrompt: "Use message(action=send) for all visible replies.",
        terminalReplyExpectation:
          params.terminalReplyExpectation ??
          (params.inboundEventKind === "room_event" ? "optional" : "required"),
      },
    });

    setRuntimeConfigSnapshot(followupRun.run.config);

    let attempt = 0;
    const execute = async (queuedRun: FollowupRun, runResult = createRunResult()) => {
      const runId = `stranded-${path.basename(tmp)}-${attempt++}`;
      runEmbeddedAgentMock.mockResolvedValue(runResult);
      const agentEvents: AgentEventPayload[] = [];
      const unsubscribe = subscribeAgentEvent((event) => {
        if (event.runId === runId) {
          agentEvents.push(event);
        }
      });
      try {
        const result = await runReplyAgent({
          commandBody: queuedRun.prompt,
          followupRun: queuedRun,
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
            toolsAllow: queuedRun.toolsAllow,

            onDeliberateSilentTerminalReply: params.onDeliberateSilentTerminalReply,
            onObservedReplyDelivery: params.onObservedReplyDelivery,
            onReplyOperationOwned: params.onReplyOperationOwned,
          },
        });
        const terminalEvent = agentEvents.find(
          (event) =>
            event.stream === "lifecycle" &&
            (event.data.phase === "end" || event.data.phase === "error"),
        );
        return { result, finalAssistantText, terminalEvent, runResult };
      } finally {
        unsubscribe();
      }
    };
    return {
      ...(await execute(followupRun, createRunResult())),
      followupRun,
      storePath,
      executeRetry: (queuedRun: FollowupRun, delivered: boolean, retryText?: string) =>
        execute(queuedRun, createRunResult(delivered, retryText)),
    };
  }

  it.each([false, true])(
    "keeps an optional group private final quiet (retry=%s)",
    async (strandedReplyRetry) => {
      vi.mocked(routeReply).mockClear();
      const { result, terminalEvent } = await runPrivateFinalCase({
        chatType: "group",
        terminalReplyExpectation: "optional",
        finalAssistantText: "No response needed.",
        strandedReplyRetry,
      });
      expectNoRecovery();
      expect(terminalEvent?.data.terminalReply).toEqual({
        disposition: "visible",
        text: "No response needed.",
      });
      expect(normalizeReplyPayloads(result).some((payload) => payload.isStatusNotice)).toBe(false);
      expect(routeReply).not.toHaveBeenCalled();
    },
  );

  const visibleFinal = "Visible answer that should be delivered to the source chat.";
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

  it.each([
    { name: "delivered", outcome: "delivered", emptyPayloads: false },
    { name: "missed", outcome: "missed", emptyPayloads: false },
    { name: "missed without payloads", outcome: "missed", emptyPayloads: true },
    { name: "silent", outcome: "silent", emptyPayloads: false },
    { name: "retry decides no reply is needed", outcome: "retry-silent", emptyPayloads: false },
  ] as const)(
    "settles message-tool-only terminal outcome: $name",
    async ({ outcome, emptyPayloads }) => {
      vi.mocked(enqueueFollowupRun).mockReturnValue(true);
      vi.mocked(routeReply).mockClear();
      const initial = await runPrivateFinalCase({
        finalAssistantText: outcome === "silent" ? "NO_REPLY" : "Done — deployed v2 to staging.",
        transcriptPrompt: "Deploy v2 to staging.",
        payloads: emptyPayloads ? [] : undefined,
      });
      expect(normalizeReplyPayloads(initial.result).some((payload) => payload.isError)).toBe(false);
      if (outcome === "silent") {
        expect(initial.terminalEvent?.data.terminalReply).toEqual({ disposition: "silent" });
        expectNoRecovery();
        expect(routeReply).not.toHaveBeenCalled();
        return;
      }

      const strandedFact = { disposition: "empty", code: "message-tool-not-called" };
      expect(initial.terminalEvent?.data.terminalReply).toEqual(strandedFact);
      expect(warnPrivateFinalSpy).toHaveBeenCalledOnce();
      expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
      const retryRun = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
      assert(retryRun);
      expect(retryRun.prompt).toContain("Done — deployed v2 to staging.");
      expect(retryRun.prompt).toMatch(/^\[System\] /);
      expect(retryRun.prompt).toContain("message(action=send)");
      expect(retryRun.prompt).toContain("If the user should see a reply, send it now");
      expect(retryRun.prompt).toContain("If no reply is needed, answer exactly NO_REPLY.");
      expect(retryRun.prompt).not.toContain("Please deliver this reply now");
      expect(retryRun.prompt).not.toBe(initial.followupRun.prompt);
      expect(retryRun.transcriptPrompt).toBeUndefined();
      expect(retryRun.userTurnTranscriptRecorder).toBeUndefined();
      expect(retryRun.currentInboundContext).toBeUndefined();
      expect(retryRun.disableCollectBatching).toBe(true);
      expect(retryRun.toolsAllow).toEqual(["message"]);
      expect(retryRun.run).toMatchObject({
        config: initial.followupRun.run.config,
        extraSystemPrompt: initial.followupRun.run.extraSystemPrompt,
        sourceReplyDeliveryMode: "message_tool_only",
        suppressNextUserMessagePersistence: true,
      });
      expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[3]).toBe("none");
      expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[5]).toBe(false);
      expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[6]).toEqual({
        position: "front",
        storePath: initial.storePath,
      });

      const retry = await initial.executeRetry(
        retryRun,
        outcome === "delivered",
        outcome === "retry-silent" ? "NO_REPLY" : undefined,
      );
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
      expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toMatchObject({
        prompt: retryRun.prompt,
        toolsAllow: ["message"],
        extraSystemPrompt: initial.followupRun.run.extraSystemPrompt,
        sourceReplyDeliveryMode: "message_tool_only",
        suppressNextUserMessagePersistence: true,
      });
      expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
      expect(warnPrivateFinalSpy).toHaveBeenCalledOnce();
      const deliverable = normalizeReplyPayloads(retry.result).filter(
        (payload) => getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression,
      );
      if (outcome === "delivered" || outcome === "retry-silent") {
        expect(deliverable).toEqual([]);
        expect(normalizeReplyPayloads(retry.result).some((payload) => payload.isError)).toBe(false);
        expect(routeReply).not.toHaveBeenCalled();
        if (outcome === "delivered") {
          expect(retry.runResult.messagingToolSourceReplyPayloads).toEqual([
            { text: "Done — deployed v2 to staging." },
          ]);
          expect(retry.terminalEvent?.data.terminalReply).toMatchObject({ disposition: "visible" });
        } else {
          expect(retry.terminalEvent?.data.terminalReply).toEqual({ disposition: "silent" });
        }
        return;
      }

      expect(retry.terminalEvent?.data.terminalReply).toEqual(strandedFact);
      expect(deliverable).toEqual([
        expect.objectContaining({
          text: MISSING_REPLY_NOTICE_TEXT,
          isError: true,
          isStatusNotice: true,
        }),
      ]);
      const notice = deliverable[0];
      assert(notice);
      expect(getReplyPayloadMetadata(notice)).toMatchObject({
        assistantTranscriptOwned: true,
        deliverDespiteSourceReplySuppression: true,
      });
      const delivered = await deliverFollowupDecision({
        decision: { kind: "deliver", payloads: deliverable },
        turn: createTurn({
          queued: { ...retryRun, originatingChannel: "whatsapp", originatingTo: "+15550001111" },
          config: retryRun.run.config,
        }),
        defaults: createDefaults(vi.fn()),
        runId: "stranded-notice",
        runFollowup: vi.fn(),
      });
      expect(delivered).toEqual({ kind: "completed", payloads: [] });
      // The real delivery owner disables transcript writes; the mocked model does not persist rows.
      expect(routeReply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ payload: deliverable[0], mirror: false }),
      );
    },
  );

  it.each([
    ["yielded visible final", { pendingContinuation: true }],
    [
      "implicit continuation with no final",
      { implicitContinuation: true, finalAssistantText: "", payloads: [] },
    ],
  ] satisfies Array<[string, Parameters<typeof runPrivateFinalCase>[0]]>)(
    "does not strand a %s",
    async (_name, params) => {
      const { terminalEvent, runResult, finalAssistantText } = await runPrivateFinalCase(params);
      const expected = prepareAgentRunTerminalReply({ rawText: finalAssistantText }).terminalReply;
      expect(terminalEvent?.data.terminalReply).toEqual(expected);
      expect(runResult.meta.terminalReply).toEqual(expected);
      expectNoRecovery();
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
      expect(payloads).toEqual([]);
      expect(onDeliberateSilentTerminalReply).toHaveBeenCalledOnce();
      expectNoRecovery();
    },
  );

  it("returns one missing-answer notice if the retry cannot be enqueued", async () => {
    vi.mocked(enqueueFollowupRun).mockReturnValueOnce(false);
    const { result, finalAssistantText } = await runPrivateFinalCase({});
    expect(warnPrivateFinalSpy).toHaveBeenCalledOnce();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
    const payloads = expectSanitizedDiagnostic(result);
    expect(payloads.filter((payload) => payload.text === MISSING_REPLY_NOTICE_TEXT)).toHaveLength(
      1,
    );
    const original = payloads.find((payload) => payload.text === finalAssistantText);
    expect(original).toBeDefined();
    expect(getReplyPayloadMetadata(original ?? {})?.deliverDespiteSourceReplySuppression).not.toBe(
      true,
    );
  });

  it.each([false, true])(
    "diagnoses empty retry output only without source delivery (delivered=%s)",
    async (delivered) => {
      const { result } = await runPrivateFinalCase({
        summaryLine: "stranded-reply-retry",
        strandedReplyRetry: true,
        finalAssistantText: "",
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
    const onReplyOperationOwned = vi.fn<(operation: ReplyOperation) => boolean>(() => true);
    vi.mocked(enqueueFollowupRun).mockReturnValueOnce(true);

    vi.mocked(scheduleFollowupDrain).mockImplementation((key) => {
      expect(key).toBe(sessionKey);
      expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
    });

    await runPrivateFinalCase({ onReplyOperationOwned });
    const replyOperation = onReplyOperationOwned.mock.calls[0]?.[0];
    assert(replyOperation);

    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(getSessionControllerOperation(sessionKey)).toBe(replyOperation);
    expect(scheduleFollowupDrain).not.toHaveBeenCalled();

    replyOperation.complete();

    expect(scheduleFollowupDrain).toHaveBeenCalledTimes(1);
  });
});

describe("completed Telegram message-tool reply usage (#178404)", () => {
  afterEach(() => setActivePluginRegistry(createTestRegistry()));

  it.each(["tokens", "full", "off"] as const)(
    "handles %s usage without disclosing the private final",
    async (responseUsage) => {
      const sessionKey = "agent:main:telegram:direct:123";
      const storePath = path.join(rootDir, `sessions-${responseUsage}.json`);
      const sessionEntry = { sessionId: "session", updatedAt: 1, responseUsage };
      await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
      const cfg = {
        session: { store: storePath },
        messages: { visibleReplies: "message_tool" as const },
        channels: { telegram: { enabled: true } },
      };
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: createChannelTestPluginBase({ id: "telegram" }),
          },
        ]),
      );
      const privateFinal = "Private completion text must not reach Telegram.";
      runEmbeddedAgentMock.mockResolvedValue({
        payloads: [{ text: privateFinal }],
        meta: {
          agentMeta: { usage: { input: 120, output: 30 } },
          finalAssistantVisibleText: privateFinal,
          terminalReply: prepareAgentRunTerminalReply({ rawText: privateFinal }).terminalReply,
        },
        sourceReplyDeliveryState: "delivered",
        didDeliverSourceReplyViaMessageTool: true,
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "telegram",
            to: "123",
            sourceReplyFinal: true,
            text: "Already delivered answer",
          },
        ],
      });
      const delivered: ReplyPayload[] = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          delivered.push(payload);
        },
      });
      const ctx = buildTestCtx({
        Body: "hello",
        Provider: "telegram",
        Surface: "telegram",
        From: "telegram:123",
        To: "telegram:123",
        OriginatingChannel: "telegram",
        OriginatingTo: "123",
        SessionKey: sessionKey,
        AccountId: "default",
        MessageSid: `inbound-${responseUsage}`,
      });
      const result = await createBaseRun({
        context: ctx,
        run: {
          config: cfg,
          sessionKey,
          messageProvider: "telegram",
          sourceReplyDeliveryMode: "message_tool_only",
        },
        reply: {
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          sessionKey,
          storePath,
        },
      }).run();
      await withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx,
            cfg,
            dispatcher,
            replyResolver: async () => result,
          }),
      });

      if (responseUsage === "off") {
        expect(delivered).toEqual([]);
      } else {
        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toMatchObject({ text: expect.any(String), isStatusNotice: true });
        const footer = delivered[0];
        assert(footer);
        expect(getReplyPayloadMetadata(footer)?.responseUsageLine).toBe(footer.text);
        if (responseUsage === "tokens") {
          expect(footer.text).toBe("Usage: 120 in / 30 out");
        } else {
          expect(footer.text).toContain("claude");
        }
      }
      expect(JSON.stringify(delivered)).not.toContain(privateFinal);
      expect(JSON.stringify(delivered)).not.toContain("Already delivered answer");
    },
  );
});

describe("resolveFollowupDeliveryDecision usage footer", () => {
  it.each([
    {
      name: "a completed message-tool-only source reply",
      deliveredViaMessageTool: true,
      expectUsageFooter: true,
    },
    {
      name: "no completed message-tool-only source reply",
      deliveredViaMessageTool: false,
      expectUsageFooter: false,
    },
  ] as const)(
    "handles usage for $name without replaying private final text",
    async ({ deliveredViaMessageTool, expectUsageFooter }) => {
      const privateFinalText = "This is the private final answer.";
      const turn = createTurn({ config: { messages: { responseUsage: "full" } } });
      turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
      turn.queued.run.messageProvider = "telegram";
      turn.queued.originatingChannel = "telegram";
      turn.queued.originatingTo = "123456";
      turn.queued.originatingChatType = "direct";
      turn.session.current = () => ({
        sessionId: "session",
        updatedAt: 1,
        responseUsage: "full",
      });

      const execution = createSettledExecution(privateFinalText);
      execution.outcome.result.didDeliverSourceReplyViaMessageTool = deliveredViaMessageTool;
      expect(hasCompletedSourceReplyDeliveryEvidence(execution.outcome.result)).toBe(
        deliveredViaMessageTool,
      );
      const decision = await resolveFollowupDeliveryDecision({
        turn,
        execution,
        accounting: createAccounting([{ text: privateFinalText }], {
          usage: { input: 120, output: 35, total: 155 },
        }),
      });

      const deliveredPayloads = decision.kind === "deliver" ? decision.payloads : [];
      expect(deliveredPayloads).toHaveLength(expectUsageFooter ? 1 : 0);
      if (expectUsageFooter) {
        const footer = deliveredPayloads[0];
        assert(footer);
        expect(footer).toMatchObject({ isStatusNotice: true, text: expect.any(String) });
        expect(getReplyPayloadMetadata(footer)?.deliverDespiteSourceReplySuppression).toBe(true);
      }
      expect(deliveredPayloads.map((payload) => payload.text)).not.toContain(privateFinalText);
    },
  );
});
