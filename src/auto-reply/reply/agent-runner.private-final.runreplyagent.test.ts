import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { prepareAgentRunTerminalReply } from "../../agents/agent-run-terminal-reply.js";
import { MISSING_REPLY_NOTICE_TEXT } from "../../agents/reply-completion.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  onAgentEvent as subscribeAgentEvent,
  type AgentEventPayload,
} from "../../infra/agent-events.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import {
  rootDir,
  runEmbeddedAgentMock,
  setupAgentRunnerTestHooks,
  tempDirs,
  warnPrivateFinalSpy,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import { createBaseRun } from "./agent-runner.runreplyagent.test-support.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import {
  createAccounting,
  createDefaults,
  createSettledExecution,
  createTurn,
} from "./followup-delivery.test-helpers.js";
import { enqueueFollowupRun } from "./queue.js";
import type { FollowupRun } from "./queue/types.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { routeReply } from "./route-reply.js";
import type * as RouteReplyModule from "./route-reply.js";
import { buildTestCtx } from "./test-ctx.js";
import { createReplyParams } from "./test-helpers.js";

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

function normalizeReplyPayloads(result: Awaited<ReturnType<typeof runReplyAgent>>): ReplyPayload[] {
  return result === undefined ? [] : Array.isArray(result) ? result : [result];
}

function expectNoRecovery() {
  expect(warnPrivateFinalSpy).not.toHaveBeenCalled();
  expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
}

function expectOneRecovery() {
  expect(warnPrivateFinalSpy).toHaveBeenCalledOnce();
  expect(enqueueFollowupRun).toHaveBeenCalledOnce();
}

function expectSanitizedDiagnostic(result: Awaited<ReturnType<typeof runReplyAgent>>) {
  const payloads = normalizeReplyPayloads(result);
  const diagnostic = payloads.find((payload) => payload.text === MISSING_REPLY_NOTICE_TEXT);
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
  payloads?: ReplyPayload[];
  successfulCronAdds?: number;
  transcriptPrompt?: string;
  summaryLine?: string;
  strandedReplyRetry?: boolean;
  chatType?: "direct" | "group";
  terminalReplyExpectation?: "required" | "optional";
  pendingContinuation?: boolean;
  implicitContinuation?: boolean;
  onDeliberateSilentTerminalReply?: () => void;
  onObservedReplyDelivery?: () => Promise<void> | void;
  channel?: "whatsapp" | "telegram";
  responseUsage?: "tokens" | "full" | "off";
  sourceReplyDeliveryState?: "delivered";
}) {
  const tmp = tempDirs.make("openclaw-stranded-");
  const storePath = path.join(tmp, "sessions.json");
  const channel = params.channel ?? "whatsapp";
  const sessionKey = channel === "telegram" ? "agent:main:telegram:direct:123" : "stranded";
  const sessionEntry = {
    sessionId: "session",
    updatedAt: Date.now(),
    totalTokens: 1_000,
    responseUsage: params.responseUsage,
  };
  await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);

  const finalAssistantText = params.finalAssistantText ?? "Done — deployed v2 to staging.";
  const to = channel === "telegram" ? "123" : "+15550001111";
  const createRunResult = (retryDelivered?: boolean, retryText?: string) => ({
    // Metadata payloads must not be mistaken for the assistant's final text.
    payloads:
      retryText === undefined
        ? (params.payloads ?? [{ text: finalAssistantText }])
        : [{ text: retryText }],
    meta: {
      agentMeta: params.responseUsage ? { usage: { input: 120, output: 30 } } : {},
      finalAssistantVisibleText: retryText ?? finalAssistantText,
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
    sourceReplyDeliveryState: params.sourceReplyDeliveryState,
  });

  const { sessionCtx, followupRun } = createBaseRun({
    context: {
      Provider: channel,
      OriginatingChannel: channel,
      OriginatingTo: to,
      AccountId: "primary",
      MessageSid: "msg",
      ChatType: params.chatType ?? "direct",
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
      messageProvider: channel,
      workspaceDir: tmp,
      // Carry the canonical tool-only run fact and keep downstream policy aligned,
      // so the private final is never eligible for automatic source delivery.
      config: {
        session: { store: storePath },
        messages: { visibleReplies: "message_tool" },
        ...(channel === "telegram" ? { channels: { telegram: { enabled: true } } } : {}),
      },
      thinkingCatalog: [{ provider: "anthropic", id: "claude", input: ["text"] }],
      thinkLevel: "low",
      reasoningLevel: "on",
      sourceReplyDeliveryMode: "message_tool_only",
      extraSystemPrompt: "Use message(action=send) for all visible replies.",
      terminalReplyExpectation: params.terminalReplyExpectation ?? "required",
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
      const result = await runReplyAgent(
        createReplyParams(queuedRun, {
          sessionCtx,
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          sessionKey,
          storePath,
          defaultModel: "anthropic/claude-opus-4-6",
          typingMode: "instant",
          opts: {
            runId,
            toolsAllow: queuedRun.toolsAllow,
            onDeliberateSilentTerminalReply: params.onDeliberateSilentTerminalReply,
            onObservedReplyDelivery: params.onObservedReplyDelivery,
          },
        }),
      );
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
    sessionCtx,
    storePath,
    executeRetry: (queuedRun: FollowupRun, delivered: boolean, retryText?: string) =>
      execute(queuedRun, createRunResult(delivered, retryText)),
  };
}

describe("runReplyAgent stranded message_tool_only finals (#85714)", () => {
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
    ["raw final tags", { finalAssistantRawText: `<final>${visibleFinal}</final>` }, ["<final>"]],
    [
      "reply directives",
      { finalAssistantText: `[[reply_to_current]] ${visibleFinal}` },
      ["[[reply_to_current]]"],
    ],
    [
      "trace and status payloads",
      {
        payloads: [
          { text: visibleFinal },
          {
            text: "🔎 Model Input (User Role):\n```text\nsecret user trace that must not reach chat\n```",
          },
          { text: "🧩 Active Memory: status=ok query=private-context", isStatusNotice: true },
        ],
      },
      ["secret user trace", "Active Memory"],
    ],
  ] satisfies Array<[string, Parameters<typeof runPrivateFinalCase>[0], string[]]>)(
    "excludes %s from the recovery prompt",
    async (_name, params, excluded) => {
      await runPrivateFinalCase({ finalAssistantText: visibleFinal, ...params });
      expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
      const retryRun = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
      expect(retryRun?.prompt).toContain(visibleFinal);
      for (const text of excluded) {
        expect(retryRun?.prompt).not.toContain(text);
      }
    },
  );

  it.each([
    { name: "delivered", outcome: "delivered", emptyPayloads: false },
    { name: "missed", outcome: "missed", emptyPayloads: false },
    { name: "missed without payloads", outcome: "missed", emptyPayloads: true },
    { name: "retry decides no reply is needed", outcome: "retry-silent", emptyPayloads: false },
  ] as const)(
    "settles message-tool-only terminal outcome: $name",
    async ({ outcome, emptyPayloads }) => {
      vi.mocked(enqueueFollowupRun).mockReturnValue(true);
      vi.mocked(routeReply).mockClear();
      const onObservedReplyDelivery = vi.fn(async () => {});
      const initial = await runPrivateFinalCase({
        transcriptPrompt: "Deploy v2 to staging.",
        payloads: emptyPayloads ? [] : undefined,
        onObservedReplyDelivery,
      });
      expect(normalizeReplyPayloads(initial.result).some((payload) => payload.isError)).toBe(false);
      const strandedFact = { disposition: "empty", code: "message-tool-not-called" };
      expect(initial.terminalEvent?.data.terminalReply).toEqual(strandedFact);
      expectOneRecovery();
      expect(onObservedReplyDelivery).not.toHaveBeenCalled();
      const retryRun = vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1];
      assert(retryRun);
      expect(retryRun.transcriptPrompt).toBeUndefined();
      expect(retryRun.userTurnTranscriptRecorder).toBeUndefined();
      expect(retryRun.currentInboundContext).toBeUndefined();
      expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[3]).toBe("none");
      expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[5]).toBe(false);
      expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[6]).toEqual({
        position: "front",
        storePath: initial.storePath,
      });

      const retry = await initial.executeRetry(
        retryRun,
        outcome === "delivered",
        outcome === "retry-silent" ? "NO_REPLY" : emptyPayloads ? "" : undefined,
      );
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
      expect(onObservedReplyDelivery).toHaveBeenCalledTimes(outcome === "delivered" ? 1 : 0);
      expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toMatchObject({
        prompt: retryRun.prompt,
        toolsAllow: ["message"],
        extraSystemPrompt: initial.followupRun.run.extraSystemPrompt,
        sourceReplyDeliveryMode: "message_tool_only",
        suppressNextUserMessagePersistence: true,
      });
      expectOneRecovery();
      const deliverable = normalizeReplyPayloads(retry.result).filter(
        (payload) => getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression,
      );
      if (outcome === "delivered" || outcome === "retry-silent") {
        expect(deliverable).toEqual([]);
        expect(normalizeReplyPayloads(retry.result).some((payload) => payload.isError)).toBe(false);
        expect(routeReply).not.toHaveBeenCalled();
        if (outcome === "delivered") {
          expect(retry.terminalEvent?.data.terminalReply).toEqual({
            disposition: "visible",
            text: initial.finalAssistantText,
          });
        } else {
          expect(retry.terminalEvent?.data.terminalReply).toEqual({ disposition: "silent" });
        }
        return;
      }

      expect(retry.terminalEvent?.data.terminalReply).toEqual(strandedFact);
      expect(deliverable).toHaveLength(1);
      expectSanitizedDiagnostic(retry.result);
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
      const { terminalEvent, finalAssistantText } = await runPrivateFinalCase(params);
      const expected = prepareAgentRunTerminalReply({ rawText: finalAssistantText }).terminalReply;
      expect(terminalEvent?.data.terminalReply).toEqual(expected);
      expectNoRecovery();
    },
  );

  it("does not attest progress-only source delivery", async () => {
    const onObservedReplyDelivery = vi.fn(async () => {});
    await runPrivateFinalCase({
      didDeliverSourceReplyViaMessageTool: true,
      onObservedReplyDelivery,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "whatsapp",
          to: "+15550001111",
          sourceReplyFinal: false,
          text: "Working on it.",
        },
      ],
    });
    expectOneRecovery();
    expect(onObservedReplyDelivery).not.toHaveBeenCalled();
  });

  it.each([
    [
      "non-source message",
      {
        messagingToolSentTargets: [{ tool: "message", provider: "whatsapp", to: "+15559998888" }],
      },
    ],
    ["cron side effect", { successfulCronAdds: 1 }],
    ["user-controlled retry marker", { summaryLine: "stranded-reply-retry" }],
  ] satisfies Array<[string, Parameters<typeof runPrivateFinalCase>[0]]>)(
    "does not accept %s as source delivery or retry authority",
    async (_name, params) => {
      await runPrivateFinalCase(params);
      expectOneRecovery();
    },
  );

  it.each(["required", "optional"] as const)(
    "accounts for a %s NO_REPLY turn when metadata payloads remain",
    async (terminalReplyExpectation) => {
      const onDeliberateSilentTerminalReply = vi.fn();
      const { result, terminalEvent } = await runPrivateFinalCase({
        terminalReplyExpectation,
        finalAssistantText: "NO_REPLY",
        finalAssistantRawText: "NO_REPLY",
        onDeliberateSilentTerminalReply,
        payloads: [{ text: "Auto-compaction complete (count 1).", isStatusNotice: true }],
      });
      const payloads = normalizeReplyPayloads(result);
      expect(payloads).toEqual([]);
      expect(onDeliberateSilentTerminalReply).toHaveBeenCalledOnce();
      expect(terminalEvent?.data.terminalReply).toEqual({ disposition: "silent" });
      expect(routeReply).not.toHaveBeenCalled();
      expectNoRecovery();
    },
  );

  it("returns one missing-answer notice if the retry cannot be enqueued", async () => {
    vi.mocked(enqueueFollowupRun).mockReturnValueOnce(false);
    const { result, finalAssistantText } = await runPrivateFinalCase({});
    expectOneRecovery();
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

  it("does not diagnose empty retry output after source delivery", async () => {
    const { result } = await runPrivateFinalCase({
      summaryLine: "stranded-reply-retry",
      strandedReplyRetry: true,
      finalAssistantText: "",
      messagingToolSourceReplyPayloads: [{ text: "visible recovered reply" }],
    });
    expect(
      normalizeReplyPayloads(result).some((payload) => payload.text === MISSING_REPLY_NOTICE_TEXT),
    ).toBe(false);
  });
});

describe("completed Telegram message-tool reply usage (#178404)", () => {
  afterEach(() => setActivePluginRegistry(createTestRegistry()));

  it.each(["tokens", "full", "off"] as const)(
    "handles %s usage without disclosing the private final",
    async (responseUsage) => {
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
      const { result, followupRun, sessionCtx } = await runPrivateFinalCase({
        channel: "telegram",
        responseUsage,
        finalAssistantText: privateFinal,
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
        ...sessionCtx,
        Body: "hello",
        Surface: "telegram",
        From: "telegram:123",
        To: "telegram:123",
        SessionKey: followupRun.run.sessionKey,
        MessageSid: `inbound-${responseUsage}`,
      });
      await withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx,
            cfg: followupRun.run.config,
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
  it.each([true, false])(
    "only delivers usage for a completed message-tool reply (delivered=%s)",
    async (deliveredViaMessageTool) => {
      const privateFinalText = "This is the private final answer.";
      const turn = createTurn({ config: { messages: { responseUsage: "full" } } });
      turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
      turn.queued.originatingChatType = "direct";

      const execution = createSettledExecution(privateFinalText);
      execution.outcome.result.didDeliverSourceReplyViaMessageTool = deliveredViaMessageTool;
      const decision = await resolveFollowupDeliveryDecision({
        turn,
        execution,
        accounting: createAccounting([{ text: privateFinalText }], {
          usage: { input: 120, output: 35, total: 155 },
        }),
      });

      const deliveredPayloads = decision.kind === "deliver" ? decision.payloads : [];
      expect(deliveredPayloads).toHaveLength(deliveredViaMessageTool ? 1 : 0);
      if (deliveredViaMessageTool) {
        const footer = deliveredPayloads[0];
        assert(footer);
        expect(footer).toMatchObject({ isStatusNotice: true, text: expect.any(String) });
        expect(getReplyPayloadMetadata(footer)?.deliverDespiteSourceReplySuppression).toBe(true);
      }
      expect(deliveredPayloads.map((payload) => payload.text)).not.toContain(privateFinalText);
    },
  );
});
