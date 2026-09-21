import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { observeReplyDelivery } from "../../agents/reply-completion.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../agents/stream-message-shared.js";
import {
  copyReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyDispatchOperation } from "../../auto-reply/reply/reply-dispatcher.types.js";
import {
  appendTranscriptMessageSync,
  publishTranscriptUpdate,
  readActiveTranscriptEntryAnchor,
  replaceSessionEntry,
  rewriteTranscriptMessageAtAnchor,
  SessionTranscriptProjectionUnavailableError,
} from "../../config/sessions/session-accessor.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  attachSessionTranscriptRunId,
  emitSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import * as sessionTranscriptReaders from "../session-transcript-readers.js";
import { loadSessionEntry } from "../session-utils.js";
import {
  buildAssistantReplyContent,
  buildAssistantReplyContentFromInputs,
  extractAssistantDisplayText,
} from "./chat-assistant-content.js";
import {
  readChatSendReplyPayload,
  selectChatSendFinalReplyInputs,
} from "./chat-send-command-replies.js";
import {
  buildTranscriptReplyTextFromInputs,
  createChatSendReplyDispatch,
} from "./chat-send-reply-dispatch.js";

async function createReplyTranscriptFixture() {
  const runId = "receipt-run";
  const scope = {
    agentId: "main",
    sessionId: "receipt-session",
    sessionKey: "agent:main:receipt",
    storePath: loadSessionEntry("agent:main:receipt", { agentId: "main" }).storePath,
  };
  const sessionEntry = {
    sessionId: scope.sessionId,
    lifecycleRevision: "initial",
    updatedAt: 1,
  };
  await replaceSessionEntry(scope, sessionEntry);
  const append = async (messageId: string, message: Record<string, unknown>, parentId?: string) => {
    const persisted = attachSessionTranscriptRunId(message, runId);
    const result = appendTranscriptMessageSync(scope, {
      eventId: messageId,
      message: persisted,
      ...(parentId ? { parentId } : {}),
    });
    if (!result?.ok) {
      throw new Error("Expected committed receipt fixture message");
    }
    // Tool-bearing assistant updates intentionally have no top-level runId.
    await publishTranscriptUpdate(scope, { message: persisted, messageId });
  };
  const userTurnRecorder = createUserTurnTranscriptRecorder({
    input: {
      text: "Inspect the synthetic fixture.",
      idempotencyKey: `${runId}:user`,
    },
    target: { ...scope, sessionEntry },
  });
  const persistedInput = await userTurnRecorder.persistApproved();
  if (!persistedInput?.messageId) {
    throw new Error("Expected committed input admission");
  }
  let current = true;
  const abortController = new AbortController();
  const dispatch = createChatSendReplyDispatch({
    accountId: undefined,
    isAgentRunStarted: () => true,
    isRunCurrent: () => current,
    abortSignal: abortController.signal,
    logGateway: { ...createSubsystemLogger("test/chat-send-reply-dispatch"), warn: vi.fn() },
    session: {
      ...scope,
      backingSessionId: scope.sessionId,
      cfg: {},
      clientRunId: runId,
      sessionLoadOptions: { agentId: "main" },
    },
    userTurnRecorder,
  });
  return {
    scope,
    runId,
    inputId: persistedInput.messageId,
    append,
    dispatch,
    abortController,
    retire: () => {
      current = false;
    },
  };
}

function buildRawTranscriptReplyText(payloads: ReplyPayload[]): string {
  return buildTranscriptReplyTextFromInputs(payloads.map((payload) => ({ kind: "raw", payload })));
}

function createReplyDispatchSession(clientRunId: string) {
  return {
    agentId: "main",
    backingSessionId: undefined,
    cfg: {},
    clientRunId,
    sessionKey: "agent:main:main",
    sessionLoadOptions: { agentId: "main" },
  };
}

describe("buildTranscriptReplyTextFromInputs", () => {
  it.each(["NO_REPLY", "ANNOUNCE_SKIP", "REPLY_SKIP"])(
    "keeps %s out of combined command display text",
    async (controlText) => {
      const payloads = [{ text: "First instruction" }, { text: controlText }, { text: "Done" }];
      expect(buildRawTranscriptReplyText(payloads)).toBe("First instruction\n\nDone");
      expect(
        (
          await buildAssistantReplyContent({
            sessionKey: "agent:main:main",
            agentId: "main",
            payloads,
          })
        ).assistantContent,
      ).toEqual([{ type: "text", text: "First instruction\n\nDone" }]);
    },
  );

  it("preserves authored indentation across split fenced-code reply payloads", () => {
    expect(
      buildRawTranscriptReplyText([
        { text: "Here is the YAML:\n\n```yaml\nroot:\n" },
        { text: "  nested:\n    value: true\n```" },
      ]),
    ).toBe("Here is the YAML:\n\n```yaml\nroot:\n  nested:\n    value: true\n```");
  });

  it("preserves authored CRLF boundaries and skips whitespace-only reply payloads", () => {
    expect(
      buildRawTranscriptReplyText([
        { text: "```yaml\r\nroot:\r\n" },
        { text: "  \t\n" },
        { text: "  nested: true\r\n```" },
      ]),
    ).toBe("```yaml\r\nroot:\r\n  nested: true\r\n```");
  });

  it("keeps reply directives and safe media while suppressing reasoning", () => {
    expect(
      buildRawTranscriptReplyText([
        { text: "hidden", isReasoning: true },
        {
          text: "Hello",
          replyToId: "message-1",
          mediaUrls: ["https://example.test/photo.png"],
        },
        {
          text: "Listen",
          audioAsVoice: true,
          mediaUrl: "https://example.test/clip.mp3",
        },
        {
          text: "private",
          sensitiveMedia: true,
          mediaUrl: "https://example.test/private.png",
        },
      ]),
    ).toBe(
      [
        "[[reply_to:message-1]]\nHello\nAttachment: https://example.test/photo.png",
        "Listen\nAttachment: https://example.test/clip.mp3\n[[audio_as_voice]]",
        "private",
      ].join("\n\n"),
    );
  });
});

describe("buildAssistantReplyContentFromInputs", () => {
  it.each([
    { kind: "raw", withAnswer: false },
    { kind: "prepared", withAnswer: false },
    { kind: "raw", withAnswer: true },
    { kind: "prepared", withAnswer: true },
  ] as const)(
    "omits $kind reasoning from both projections (answer: $withAnswer)",
    async ({ kind, withAnswer }) => {
      const payloads: ReplyPayload[] = [
        { text: "Checking the arithmetic.", isReasoning: true },
        ...(withAnswer ? [{ text: "The result is 4." }] : []),
      ];
      const inputs =
        kind === "raw"
          ? payloads.map((payload): ReplyDispatchOperation => ({ kind: "raw", payload }))
          : createStructuredOutboundPayloadPlan(payloads).map((plan): ReplyDispatchOperation => ({
              kind: "prepared",
              plan,
            }));
      const content = await buildAssistantReplyContentFromInputs({
        sessionKey: "agent:main:main",
        agentId: "main",
        inputs,
        transcriptMediaMessage: {
          content: [],
          transcriptText: "",
          payloadTexts: ["Thinking text for slot zero.", "The persisted result is 4."],
        },
      });
      const expected = withAnswer ? [{ type: "text", text: "The result is 4." }] : undefined;

      expect(content).toEqual({
        assistantContent: expected,
        persistedAssistantContent: withAnswer
          ? [{ type: "text", text: "The persisted result is 4." }]
          : undefined,
      });
    },
  );
});

describe("createChatSendReplyDispatch", () => {
  it("owns assistant media before transcript publication only during its live dispatch", async () => {
    let current = true;
    const dispatch = createChatSendReplyDispatch({
      accountId: undefined,
      isAgentRunStarted: () => true,
      isRunCurrent: () => current,
      logGateway: { ...createSubsystemLogger("test/chat-send-reply-dispatch"), warn: vi.fn() },
      session: createReplyDispatchSession("run-media"),
      userTurnRecorder: { markBlocked: vi.fn(), getAdmissionReceipt: () => undefined },
    });
    const rawText =
      "[[reply_to_current]] Artifacts ready\nMEDIA:./artifact.json\n```text\nMEDIA:./example.png\n```";
    const prepare = () =>
      runAgentHarnessBeforeMessageWriteHook({
        message: buildAssistantMessage({
          model: { api: "openai-responses", provider: "openai", id: "gpt-5.6-luna" },
          content: [{ type: "text", text: rawText }],
          stopReason: "stop",
          usage: buildUsageWithNoCost({}),
        }),
        prepareAssistantTranscriptMessage: dispatch.prepareAssistantTranscriptMessage,
      });
    expect(projectChatDisplayMessage(prepare())).toMatchObject({
      content: [{ type: "text", text: rawText }],
    });
    await dispatch.runAgentMediaTranscript({ run: async (operation) => operation() }, async () => {
      const persisted = prepare();
      expect(persisted).toMatchObject({
        content: [{ type: "text", text: rawText }],
        openclawDelivery: { mediaUrls: ["./artifact.json"] },
      });
      expect(projectChatDisplayMessage(persisted)).toMatchObject({
        content: [
          {
            type: "text",
            text: "[[reply_to_current]] Artifacts ready\n```text\nMEDIA:./example.png\n```",
          },
        ],
      });
      current = false;
      expect(prepare()).not.toHaveProperty("openclawDelivery");
      current = true;
    });
    expect(prepare()).not.toHaveProperty("openclawDelivery");
  });

  it("captures visible replies, promotes tool media, and marks blocked turns", async () => {
    const markBlocked = vi.fn();
    const onCommandBlock = vi.fn();
    const dispatch = createChatSendReplyDispatch({
      accountId: undefined,
      isAgentRunStarted: () => false,
      isRunCurrent: () => true,
      onCommandBlock,
      logGateway: { ...createSubsystemLogger("test/chat-send-reply-dispatch"), warn: vi.fn() },
      session: createReplyDispatchSession("run-1"),
      userTurnRecorder: { markBlocked, getAdmissionReceipt: () => undefined },
    });
    expect(dispatch.hasAppendedWebchatAgentMedia()).toBe(false);
    const blockedPayload = setReplyPayloadMetadata(
      { text: "blocked" },
      { beforeAgentRunBlocked: true },
    );

    const dispatcher = createReplyDispatcher(dispatch.dispatcherOptions);
    dispatcher.sendBlockReply(blockedPayload);
    dispatcher.sendToolResult({
      text: "tool summary",
      mediaUrl: "https://example.test/audio.mp3",
    });
    dispatcher.sendFinalReply({ text: "done" });
    await dispatcher.waitForIdle();

    expect(onCommandBlock).toHaveBeenCalledExactlyOnceWith("blocked");
    dispatcher.markComplete();
    expect(markBlocked).toHaveBeenCalledOnce();
    expect(
      dispatch.deliveredReplies.map(({ kind, input }) => ({
        kind,
        payload: readChatSendReplyPayload(input),
      })),
    ).toEqual([
      { payload: blockedPayload, kind: "block" },
      {
        payload: {
          text: undefined,
          mediaUrl: "https://example.test/audio.mp3",
        },
        kind: "final",
      },
      { payload: { text: "done" }, kind: "final" },
    ]);
  });

  it("preserves prepared literal directives through callback modifiers and final projection", async () => {
    const dispatch = createChatSendReplyDispatch({
      accountId: undefined,
      isAgentRunStarted: () => true,
      isRunCurrent: () => true,
      logGateway: { ...createSubsystemLogger("test/chat-send-reply-dispatch"), warn: vi.fn() },
      session: createReplyDispatchSession("run-prepared"),
      userTurnRecorder: { markBlocked: vi.fn(), getAdmissionReceipt: () => undefined },
    });
    const dispatcher = createReplyDispatcher({
      ...dispatch.dispatcherOptions,
      beforeDeliver: async (payload) =>
        copyReplyPayloadMetadata(payload, { ...payload, text: `${payload.text} changed` }),
    });
    const literalChunks = ["`prefix", "[[reply_to:literal]] [[audio_as_voice]] suffix`"];
    dispatcher.sendBlockReply({ text: "[[reply_to:command]] Command" });
    for (const plan of createStructuredOutboundPayloadPlan(
      literalChunks.map((text) => ({ text })),
    )) {
      dispatcher.sendPreparedReply("block", plan);
    }
    dispatcher.sendFinalReply({ text: "[[reply_to:command]] Command" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    const inputs = selectChatSendFinalReplyInputs({
      deliveredReplies: dispatch.deliveredReplies,
      foldCommandBlocks: true,
      suppressReplies: false,
    });
    const prepared = inputs.filter((input) => input.kind === "prepared");
    expect(prepared.map((input) => readChatSendReplyPayload(input).text)).toEqual(
      literalChunks.map((text) => `${text} changed`),
    );
    for (const input of prepared) {
      expect(readChatSendReplyPayload(input).replyToId).toBeUndefined();
      expect(readChatSendReplyPayload(input).audioAsVoice).not.toBe(true);
    }
    const visible = ["Command changed", ...literalChunks.map((text) => `${text} changed`)].join(
      "\n\n",
    );
    const content = await buildAssistantReplyContentFromInputs({
      sessionKey: "agent:main:main",
      inputs,
    });
    expect(content.assistantContent).toEqual([{ type: "text", text: visible }]);
    expect(buildTranscriptReplyTextFromInputs(inputs)).toBe(`[[reply_to:command]]\n${visible}`);
  });

  it.each([
    { operation: "raw", split: false },
    { operation: "raw", split: true },
    { operation: "prepared", split: false },
    { operation: "prepared", split: true },
  ] as const)(
    "preserves indented code through $operation WebChat replies (split=$split)",
    async ({ operation, split }) => {
      const text = "    const value = 1;\n    use(value);";
      const parts = split ? ["    const value = 1;\n", "    use(value);"] : [text];
      const dispatch = createChatSendReplyDispatch({
        accountId: undefined,
        isAgentRunStarted: () => true,
        isRunCurrent: () => true,
        logGateway: { ...createSubsystemLogger("test/chat-send-reply-dispatch"), warn: vi.fn() },
        session: createReplyDispatchSession("run-indented-code"),
        userTurnRecorder: { markBlocked: vi.fn(), getAdmissionReceipt: () => undefined },
      });
      const dispatcher = createReplyDispatcher(dispatch.dispatcherOptions);
      const payloads = parts.map((part) => ({ text: part }));
      if (operation === "prepared") {
        for (const plan of createStructuredOutboundPayloadPlan(payloads)) {
          dispatcher.sendPreparedReply("final", plan);
        }
      } else {
        for (const payload of payloads) {
          dispatcher.sendFinalReply(payload);
        }
      }
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      const inputs = selectChatSendFinalReplyInputs({
        deliveredReplies: dispatch.deliveredReplies,
        foldCommandBlocks: false,
        suppressReplies: false,
      });
      const content = await buildAssistantReplyContentFromInputs({
        sessionKey: "agent:main:main",
        inputs,
      });

      expect.soft(content.assistantContent).toEqual([{ type: "text", text }]);
      expect.soft(extractAssistantDisplayText(content.assistantContent)).toBe(text);
      expect.soft(buildTranscriptReplyTextFromInputs(inputs)).toBe(text);
    },
  );

  it("publishes ordered command text while pending and suppresses hidden or retired output", async () => {
    let current = true;
    let agentRunStarted = false;
    const onCommandBlock = vi.fn();
    const dispatch = createChatSendReplyDispatch({
      accountId: undefined,
      isAgentRunStarted: () => agentRunStarted,
      isRunCurrent: () => current,
      onCommandBlock,
      logGateway: { ...createSubsystemLogger("test/chat-send-reply-dispatch"), warn: vi.fn() },
      session: createReplyDispatchSession("run-command"),
      userTurnRecorder: { markBlocked: vi.fn(), getAdmissionReceipt: () => undefined },
    });
    const dispatcher = createReplyDispatcher(dispatch.dispatcherOptions);
    dispatcher.sendBlockReply({ text: "[[reply_to_current]] First instruction" });
    await dispatcher.waitForIdle();
    expect(onCommandBlock).toHaveBeenLastCalledWith("First instruction");
    dispatcher.sendBlockReply({ text: "Second instruction" });
    await dispatcher.waitForIdle();
    expect(onCommandBlock).toHaveBeenLastCalledWith("First instruction\n\nSecond instruction");

    onCommandBlock.mockClear();
    dispatcher.sendBlockReply({ text: "hidden reasoning", isReasoning: true });
    dispatcher.sendBlockReply({ text: "NO_REPLY" });
    dispatcher.sendBlockReply({ text: "ANNOUNCE_SKIP" });
    dispatcher.sendBlockReply({ text: "side answer", btw: { question: "side question" } });
    await dispatcher.waitForIdle();
    expect(onCommandBlock).not.toHaveBeenCalled();

    current = false;
    dispatcher.sendBlockReply({ text: "retired command" });
    await dispatcher.waitForIdle();
    expect(onCommandBlock).not.toHaveBeenCalled();

    current = true;
    agentRunStarted = true;
    dispatcher.sendBlockReply({ text: "native agent stream" });
    dispatcher.sendFinalReply({ text: "native final" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(onCommandBlock).not.toHaveBeenCalled();
  });

  it("keeps every capture and media side effect behind beforeDeliver cancellation", async () => {
    const markBlocked = vi.fn();
    const dispatch = createChatSendReplyDispatch({
      accountId: undefined,
      isAgentRunStarted: () => true,
      logGateway: { ...createSubsystemLogger("test/chat-send-reply-dispatch"), warn: vi.fn() },
      session: createReplyDispatchSession("run-cancel"),
      userTurnRecorder: { markBlocked, getAdmissionReceipt: () => undefined },
    });
    const dispatcher = createReplyDispatcher({
      ...dispatch.dispatcherOptions,
      beforeDeliver: async () => null,
    });

    dispatcher.sendBlockReply(
      setReplyPayloadMetadata({ text: "blocked" }, { beforeAgentRunBlocked: true }),
    );
    dispatcher.sendToolResult({ mediaUrl: "https://example.test/tool.png" });
    dispatcher.sendFinalReply({ mediaUrl: "https://example.test/final.png" });
    for (const plan of createStructuredOutboundPayloadPlan([
      setReplyPayloadMetadata({ text: "prepared blocked" }, { beforeAgentRunBlocked: true }),
    ])) {
      dispatcher.sendPreparedReply("block", plan);
    }
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(dispatch.deliveredReplies).toEqual([]);
    expect(dispatch.hasAppendedWebchatAgentMedia()).toBe(false);
    expect(markBlocked).not.toHaveBeenCalled();
    expect(receipt?.counts).toMatchObject({
      tool: { cancelled: 1 },
      block: { cancelled: 2 },
      final: { cancelled: 1 },
    });
  });

  it("finalizes media inside the admission without masking dispatch errors", async () => {
    const dispatchError = new Error("dispatch failed");
    const warn = vi.fn();
    let insideAdmission = false;
    let finalizedInsideAdmission = false;
    const dispatch = createChatSendReplyDispatch({
      accountId: undefined,
      isAgentRunStarted: () => {
        finalizedInsideAdmission = insideAdmission;
        throw new Error("finalizer failed");
      },
      logGateway: { ...createSubsystemLogger("test/chat-send-reply-dispatch"), warn },
      session: createReplyDispatchSession("run-finalize"),
      userTurnRecorder: { markBlocked: vi.fn(), getAdmissionReceipt: () => undefined },
    });
    const dispatcher = createReplyDispatcher(dispatch.dispatcherOptions);
    dispatcher.sendFinalReply({ mediaUrl: "https://example.test/final.png" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    await expect(
      dispatch.runAgentMediaTranscript(
        {
          run: async (operation) => {
            insideAdmission = true;
            try {
              return await operation();
            } finally {
              insideAdmission = false;
            }
          },
        },
        async () => {
          throw dispatchError;
        },
      ),
    ).rejects.toBe(dispatchError);

    expect(finalizedInsideAdmission).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("webchat media finalization failed: Error: finalizer failed"),
    );
  });

  it.each([
    { phase: "final_answer", text: "Fixture inspected.", expected: "delivered" },
    { phase: "commentary", text: "Inspecting the fixture.", expected: "missing" },
    { phase: undefined, text: "Inspecting the fixture.", expected: "missing" },
    { phase: "final_answer", text: "NO_REPLY", expected: "missing" },
    { phase: "final_answer", text: "", expected: "missing" },
  ])(
    "uses committed display answers, not tool progress ($phase, $text)",
    async ({ phase, text, expected }) => {
      await withOpenClawTestState({ label: "webchat-receipt" }, async () => {
        const { dispatch, append } = await createReplyTranscriptFixture();
        await dispatch.runAgentMediaTranscript(
          { run: async (operation) => operation() },
          async () => {
            dispatch.captureAgentTranscriptStart();
            await append("answer", {
              role: "assistant",
              stopReason: "toolUse",
              content: [
                {
                  type: "text",
                  text,
                  ...(phase
                    ? { textSignature: JSON.stringify({ v: 1, id: "answer", phase }) }
                    : {}),
                },
                { type: "toolCall", id: "read-fixture", name: "read", arguments: {} },
              ],
            });
            await append("tool-result", {
              role: "toolResult",
              toolCallId: "read-fixture",
              content: [{ type: "text", text: "Fixture exists." }],
            });
            await append("silent-terminal", {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "NO_REPLY" }],
            });
            expect(await dispatch.resolveReplyDelivery()).toBe(expected);
          },
        );
      });
    },
  );

  it("retains pending custody when committed answer projection is unavailable", async () => {
    await withOpenClawTestState({ label: "webchat-receipt-unavailable" }, async () => {
      const { dispatch, append, scope } = await createReplyTranscriptFixture();
      dispatch.captureAgentTranscriptStart();
      await append("answer", { role: "assistant", content: "Committed answer." });
      const selectedRead = vi
        .spyOn(sessionTranscriptReaders, "readSessionMessageByIdAsync")
        .mockRejectedValueOnce(new SessionTranscriptProjectionUnavailableError(scope.sessionId));
      try {
        expect(await observeReplyDelivery(dispatch.resolveReplyDelivery, 0, () => {})).toBe(
          "pending",
        );
        expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
      } finally {
        selectedRead.mockRestore();
      }
    });
  });

  it("requires a committed answer after the current input, not an earlier input or preview", async () => {
    await withOpenClawTestState({ label: "webchat-input-receipt" }, async () => {
      const { dispatch, append, scope, runId } = await createReplyTranscriptFixture();
      await append("prior-answer", { role: "assistant", content: "Earlier answer." });
      await dispatch.runAgentMediaTranscript(
        { run: async (operation) => operation() },
        async () => {
          dispatch.captureAgentTranscriptStart();
          emitSessionTranscriptUpdate({
            target: scope,
            messageId: "uncommitted-answer",
            message: attachSessionTranscriptRunId(
              { role: "assistant", content: "Preview only." },
              runId,
            ),
          });
          expect(await dispatch.resolveReplyDelivery()).toBe("missing");
          await append("first-answer", { role: "assistant", content: "Committed answer." });
          expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
          // A sealed earlier segment without its next committed input is not authority.
          expect(await dispatch.resolveReplyDelivery(8)).toBe("missing");
          await append("next-input", {
            role: "user",
            content: "Inspect the synthetic fixture.",
            idempotencyKey: "next-input:user",
          });
          expect(await dispatch.resolveReplyDelivery(8)).toBe("missing");
          await append("next-answer", { role: "assistant", content: "Next fixture inspected." });
          expect(await dispatch.resolveReplyDelivery(8)).toBe("delivered");
          dispatch.captureAgentTranscriptStart("successor-run");
          await append("retired-run-answer", {
            role: "assistant",
            content: "Late old-run answer.",
          });
          expect(await dispatch.resolveReplyDelivery()).toBe("missing");
        },
      );
      expect(await dispatch.resolveReplyDelivery()).toBe("missing");
    });
  });

  it.each([
    "retired",
    "aborted",
    "lifecycle",
    "branch",
    "answer-rewrite",
    "input-rewrite",
  ] as const)("rechecks accepted history against %s changes", async (change) => {
    await withOpenClawTestState({ label: "webchat-receipt-lifetime" }, async () => {
      const { dispatch, append, scope, inputId, abortController, retire } =
        await createReplyTranscriptFixture();
      await dispatch.runAgentMediaTranscript(
        { run: async (operation) => operation() },
        async () => {
          dispatch.captureAgentTranscriptStart();
          await append("answer", { role: "assistant", content: "Committed answer." });
          expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
          const inFlightReceipt =
            change === "retired" || change === "aborted"
              ? dispatch.resolveReplyDelivery()
              : undefined;
          if (change === "retired") {
            retire();
          } else if (change === "aborted") {
            abortController.abort();
          } else if (change === "lifecycle") {
            await replaceSessionEntry(scope, {
              sessionId: scope.sessionId,
              lifecycleRevision: "replacement",
              updatedAt: 2,
            });
          } else if (change === "branch") {
            await append("other-branch", { role: "assistant", content: "NO_REPLY" }, inputId);
          } else {
            const anchor = readActiveTranscriptEntryAnchor({
              ...scope,
              entryId: change === "answer-rewrite" ? "answer" : inputId,
            });
            if (!anchor) {
              throw new Error("Expected active rewrite fixture");
            }
            await rewriteTranscriptMessageAtAnchor(anchor, (message) => ({
              ...asOptionalRecord(message),
              content: change === "answer-rewrite" ? "NO_REPLY" : "Edited input display.",
            }));
          }
          if (inFlightReceipt) {
            expect(await inFlightReceipt).toBe("missing");
          }
          expect(await dispatch.resolveReplyDelivery()).toBe(
            change === "input-rewrite" ? "delivered" : "missing",
          );
        },
      );
    });
  });

  it.each(["new-input", "unrelated-rewrite"] as const)(
    "retains factual delivery while rechecking a concurrent %s",
    async (change) => {
      await withOpenClawTestState({ label: "webchat-receipt-freshness" }, async () => {
        const { dispatch, append, scope, inputId } = await createReplyTranscriptFixture();
        await dispatch.runAgentMediaTranscript(
          { run: async (operation) => operation() },
          async () => {
            dispatch.captureAgentTranscriptStart();
            await append("answer", { role: "assistant", content: "Committed answer." });
            const readSelected = sessionTranscriptReaders.readSessionMessageByIdAsync;
            const selectedRead = vi
              .spyOn(sessionTranscriptReaders, "readSessionMessageByIdAsync")
              .mockImplementationOnce(async (...args) => {
                const selected = await readSelected(...args);
                if (change === "new-input") {
                  await append("next-input", {
                    role: "user",
                    content: "Inspect the synthetic fixture.",
                    idempotencyKey: "next-input:user",
                  });
                } else {
                  const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: inputId });
                  if (!anchor) {
                    throw new Error("Expected current input anchor");
                  }
                  await rewriteTranscriptMessageAtAnchor(anchor, (message) => ({
                    ...asOptionalRecord(message),
                    content: "Edited input display.",
                  }));
                }
                return selected;
              });
            try {
              expect(await dispatch.resolveReplyDelivery()).toBe(
                change === "new-input" ? "missing" : "pending",
              );
            } finally {
              selectedRead.mockRestore();
            }
          },
        );
      });
    },
  );
});
