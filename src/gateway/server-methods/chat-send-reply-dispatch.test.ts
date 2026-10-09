import { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { observeReplyDelivery } from "../../agents/reply-completion.js";
import { sessionManagerReadTranscriptStart } from "../../agents/sessions/session-manager-current-turn.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../agents/stream-message-shared.js";
import {
  copyReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyDispatchOperation } from "../../auto-reply/reply/reply-dispatcher.types.js";
import { getRuntimeConfig } from "../../config/io.js";
import {
  appendTranscriptMessageSync,
  readActiveTranscriptEntryAnchor,
  resolveSessionTranscriptDatabasePath,
  replaceSessionEntry,
  rewriteTranscriptMessageAtAnchor,
  SessionTranscriptProjectionUnavailableError,
} from "../../config/sessions/session-accessor.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import * as historyReaders from "../../config/sessions/session-transcript-worker-readers.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  attachSessionTranscriptRunId,
  emitSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import * as sessionTranscriptReaders from "../session-transcript-readers.js";
import {
  buildAssistantReplyContentFromInputs,
  extractAssistantDisplayText,
} from "./chat-assistant-content.js";
import {
  buildTranscriptReplyTextFromInputs,
  readChatSendReplyPayload,
  selectChatSendFinalReplyInputs,
} from "./chat-send-command-replies.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";
import { createReplyTranscriptFixture } from "./chat-send-reply-dispatch.test-support.js";

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

function createReplyDispatch(
  clientRunId: string,
  overrides: Partial<Parameters<typeof createChatSendReplyDispatch>[0]> = {},
) {
  return createChatSendReplyDispatch({
    getRuntimeConfig,
    accountId: undefined,
    isAgentRunStarted: () => true,
    isRunCurrent: () => true,
    logGateway: { ...createSubsystemLogger("test/chat-send-reply-dispatch"), warn: vi.fn() },
    session: createReplyDispatchSession(clientRunId),
    userTurnRecorder: { markBlocked: vi.fn(), getAdmissionReceipt: () => undefined },
    ...overrides,
  });
}

function interceptDeliverySnapshot(afterRead: () => void) {
  const createReaders = historyReaders.createSessionHistoryWorkerReaders;
  return vi
    .spyOn(historyReaders, "createSessionHistoryWorkerReaders")
    .mockImplementation((runRequest) => {
      const readers = createReaders(runRequest);
      return {
        ...readers,
        readAnchors: async (input, signal) => {
          const facts = await readers.readAnchors(input, signal);
          afterRead();
          return facts;
        },
      };
    });
}

describe("chat delivery watermark preparation", () => {
  it("selects display payloads and delivery anchors in one transcript request", async () => {
    await withOpenClawTestState({ label: "chat-delivery-one-snapshot" }, async () => {
      const { dispatch, append } = await createReplyTranscriptFixture();
      dispatch.captureAgentTranscriptStart();
      await append("answer", { role: "assistant", content: "Committed answer." });
      const requests: string[] = [];
      const createReaders = historyReaders.createSessionHistoryWorkerReaders;
      const readerSpy = vi
        .spyOn(historyReaders, "createSessionHistoryWorkerReaders")
        .mockImplementation((runRequest) =>
          createReaders((prepare, ...args) =>
            runRequest(
              () => {
                const input = prepare();
                requests.push(input.kind);
                return input;
              },
              ...args,
            ),
          ),
        );
      try {
        expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
        expect(
          requests.filter((kind) =>
            ["transcript-anchors", "transcript-watermark", "history-page"].includes(kind),
          ),
        ).toEqual(["transcript-anchors"]);
      } finally {
        readerSpy.mockRestore();
      }
    });
  });

  it("consumes the committed manager boundary without caller transcript SQL", async () => {
    await withOpenClawTestState({ label: "chat-prepared-start" }, async () => {
      const { dispatch, append, scope, runId } = await createReplyTranscriptFixture();
      await append("prior-answer", { role: "assistant", content: "Earlier answer." });
      const manager = await SessionManager.openAsync(scope);
      const observed = observeHostDataSql();
      try {
        const start = manager[sessionManagerReadTranscriptStart]();
        expect(observed.queries).toEqual([]);
        expect(dispatch.captureAgentTranscriptStart(runId, start)).toBe(true);
        expect(
          observed.queries.filter((sql) =>
            /transcript_events|transcript_rewrite_watermarks|session_transcript_cold_archives/i.test(
              sql,
            ),
          ),
        ).toEqual([]);
      } finally {
        observed.restore();
      }
      expect(await dispatch.resolveReplyDelivery()).toBe("missing");
      await append("current-answer", { role: "assistant", content: "Current answer." });
      expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
      expect(
        dispatch.captureAgentTranscriptStart(runId, {
          ...scope,
          sessionKey: `${scope.sessionKey}:bound`,
          generation: null,
          maxSeq: 0,
        }),
      ).toBe(false);
      expect(await dispatch.resolveReplyDelivery()).toBe("missing");
    });
  });

  it("refuses an anchor snapshot changed by an unpublished native append", async () => {
    await withOpenClawTestState({ label: "chat-anchor-delay" }, async () => {
      const { dispatch, append, scope } = await createReplyTranscriptFixture();
      dispatch.captureAgentTranscriptStart();
      await append("answer", { role: "assistant", content: "Committed answer." });
      const createReaders = historyReaders.createSessionHistoryWorkerReaders;
      let changed = false;
      const readerSpy = vi
        .spyOn(historyReaders, "createSessionHistoryWorkerReaders")
        .mockImplementation((runRequest) => {
          const readers = createReaders(runRequest);
          return {
            ...readers,
            readAnchors: async (input, signal) => {
              const facts = await readers.readAnchors(input, signal);
              if (!changed && input.selection.includeMessagesForRunId) {
                changed = true;
                expect(
                  appendTranscriptMessageSync(scope, {
                    eventId: "late-user",
                    message: { role: "user", content: "A newly admitted question." },
                  }).ok,
                ).toBe(true);
              }
              return facts;
            },
          };
        });
      try {
        expect(await dispatch.resolveReplyDelivery()).toBe("pending");
        expect(changed).toBe(true);
      } finally {
        readerSpy.mockRestore();
      }
      expect(await dispatch.resolveReplyDelivery()).toBe("missing");
    });
  });

  it("retires a shared-store watermark with its physical owner", async () => {
    await withOpenClawTestState({ label: "chat-watermark-shared" }, async (state) => {
      const storePath = state.statePath("shared.sqlite");
      openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      const scope = {
        agentId: "ops",
        sessionKey: "agent:ops:watermark",
        sessionId: "shared-watermark",
        storePath,
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const appended = appendTranscriptMessageSync(scope, {
        eventId: "answer",
        message: { role: "assistant", content: "Shared-store answer." },
      });
      expect(appended?.ok).toBe(true);
      expect(
        await sessionTranscriptReaders.readSessionTranscriptWatermarkAsync(scope),
      ).toMatchObject({
        maxSeq: 1,
      });
      await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
      const createReaders = historyReaders.createSessionHistoryWorkerReaders;
      const readerSpy = vi
        .spyOn(historyReaders, "createSessionHistoryWorkerReaders")
        .mockImplementation((runRequest) => {
          const readers = createReaders(runRequest);
          return {
            ...readers,
            readWatermark: async (input) => {
              const watermark = await readers.readWatermark(input);
              await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
              return watermark;
            },
          };
        });
      try {
        await expect(
          sessionTranscriptReaders.readSessionTranscriptWatermarkAsync(scope),
        ).rejects.toThrow("revoked");
      } finally {
        readerSpy.mockRestore();
      }
    });
  });

  it.each([false, true])(
    "keeps watermark and current-session SQLite with their owner (incognito=%s)",
    async (incognito) => {
      await withOpenClawTestState({ label: "chat-watermark-owner" }, async () => {
        const { dispatch, append } = await createReplyTranscriptFixture(
          incognito ? "agent:main:dashboard:incognito-watermark" : undefined,
        );
        await dispatch.runAgentMediaTranscript(
          { run: async (operation) => operation() },
          async () => {
            const startingSql = observeHostDataSql();
            try {
              dispatch.captureAgentTranscriptStart();
              expect(
                startingSql.queries.filter((query) =>
                  /\bfrom\s+"?session_(?:nodes|participants)\b/i.test(query),
                ),
              ).toEqual([]);
            } finally {
              startingSql.restore();
            }
            await append("answer", { role: "assistant", content: "Committed answer." });
            const sql = observeHostDataSql();
            try {
              expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
              const watermarks = sql.queries.filter(
                (query) =>
                  query.includes('from "transcript_events"') &&
                  query.includes('from "transcript_rewrite_watermarks"'),
              );
              expect(watermarks.length > 0).toBe(incognito);
              const sessionReads = sql.queries.filter((query) =>
                /\bfrom\s+"?session_(?:nodes|participants)\b/i.test(query),
              );
              expect(sessionReads.length > 0).toBe(incognito);
            } finally {
              sql.restore();
            }
          },
        );
      });
    },
  );

  it.each(["retired", "aborted", "rejected"] as const)(
    "rechecks %s before consuming the delivery snapshot",
    async (change) => {
      await withOpenClawTestState({ label: "chat-watermark-delay" }, async () => {
        const { dispatch, append, retire, abortController } = await createReplyTranscriptFixture();
        await dispatch.runAgentMediaTranscript(
          { run: async (operation) => operation() },
          async () => {
            dispatch.captureAgentTranscriptStart();
            await append("answer", { role: "assistant", content: "Committed answer." });
            let reads = 0;
            const failure = new Error("delivery snapshot read rejected");
            const readerSpy = interceptDeliverySnapshot(() => {
              reads++;
              if (change === "retired") {
                retire();
              } else if (change === "aborted") {
                abortController.abort(failure);
              } else {
                throw failure;
              }
            });
            try {
              const delivery = dispatch.resolveReplyDelivery();
              if (change === "rejected" || change === "aborted") {
                await expect(delivery).rejects.toBe(failure);
              } else {
                expect(await delivery).toBe("missing");
              }
              expect(reads).toBe(1);
            } finally {
              readerSpy.mockRestore();
            }
          },
        );
      });
    },
  );

  it("uses admitted metadata with detached history and refreshes a changed tail", async () => {
    await withOpenClawTestState({ label: "chat-delivery-cohort" }, async () => {
      const { dispatch, append, appendSync, scope } = await createReplyTranscriptFixture();
      dispatch.captureAgentTranscriptStart();
      await append("answer", { role: "assistant", content: "Committed answer." });
      const { databaseClaim } = await loadSessionEntryForAdmission(scope);
      if (!("kind" in databaseClaim) || databaseClaim.kind !== "worker" || !databaseClaim.reader) {
        throw new Error("Expected admitted durable session reader");
      }
      try {
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: scope,
            sessionReader: databaseClaim.reader,
            withTranscriptWrite: async (write) => write(),
          },
          async () => {
            expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
            const selectedRead = interceptDeliverySnapshot(() => {
              appendSync("next-input", { role: "user", content: "A new question." });
            });
            try {
              expect(await dispatch.resolveReplyDelivery()).toBe("pending");
            } finally {
              selectedRead.mockRestore();
            }
            expect(await dispatch.resolveReplyDelivery()).toBe("missing");
            await append("next-answer", { role: "assistant", content: "The new answer." });
            expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
          },
        );
      } finally {
        await databaseClaim.release();
      }
    });
  });
});

describe("buildAssistantReplyContentFromInputs", () => {
  const notice =
    "Model Fallback: backup/model (selected primary/model; selected model unavailable)";
  const answer = "The workspace check is complete.";
  it.each([
    ...(
      [
        { kind: "raw", withAnswer: false },
        { kind: "prepared", withAnswer: false },
        { kind: "raw", withAnswer: true },
        { kind: "prepared", withAnswer: true },
      ] as const
    ).map(({ kind, withAnswer }) => ({
      name: `${kind} reasoning (answer: ${withAnswer})`,
      kind,
      payloads: [
        { text: "Checking the arithmetic.", isReasoning: true },
        ...(withAnswer ? [{ text: "The result is 4." }] : []),
      ],
      payloadTexts: ["Thinking text for slot zero.", "The persisted result is 4."],
      expected: {
        assistantContent: withAnswer ? [{ type: "text", text: "The result is 4." }] : undefined,
        persistedAssistantContent: withAnswer
          ? [{ type: "text", text: "The persisted result is 4." }]
          : undefined,
      },
    })),
    {
      name: "fallback status separate from the terminal answer",
      kind: "raw",
      payloads: [{ text: notice, isFallbackNotice: true }, { text: answer }],
      payloadTexts: undefined,
      expected: {
        assistantContent: [
          { type: "text", text: notice, openclawStatusNotice: true },
          { type: "text", text: answer },
        ],
        persistedAssistantContent: [
          { type: "text", text: notice, openclawStatusNotice: true },
          { type: "text", text: answer },
        ],
      },
    },
  ])("projects $name", async ({ kind, payloads, payloadTexts, expected }) => {
    const inputs =
      kind === "raw"
        ? payloads.map((payload): ReplyDispatchOperation => ({ kind: "raw", payload }))
        : createStructuredOutboundPayloadPlan(payloads).map((plan): ReplyDispatchOperation => ({
            kind: "prepared",
            plan,
          }));
    expect(
      await buildAssistantReplyContentFromInputs({
        sessionKey: "agent:main:main",
        ...(payloadTexts
          ? {
              agentId: "main",
              transcriptMediaMessage: { content: [], transcriptText: "", payloadTexts },
            }
          : {}),
        inputs,
      }),
    ).toEqual(expected);
  });
});

describe("createChatSendReplyDispatch", () => {
  it("owns assistant media before transcript publication only during its live dispatch", async () => {
    let current = true;
    const dispatch = createReplyDispatch("run-media", {
      isRunCurrent: () => current,
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
    const dispatch = createReplyDispatch("run-1", {
      isAgentRunStarted: () => false,
      onCommandBlock,
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
    const dispatch = createReplyDispatch("run-prepared");
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
      const dispatch = createReplyDispatch("run-indented-code");
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
    const dispatch = createReplyDispatch("run-command", {
      isAgentRunStarted: () => agentRunStarted,
      isRunCurrent: () => current,
      onCommandBlock,
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
    const dispatch = createReplyDispatch("run-cancel", {
      isRunCurrent: undefined,
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
    const dispatch = createReplyDispatch("run-finalize", {
      isRunCurrent: undefined,
      isAgentRunStarted: () => {
        finalizedInsideAdmission = insideAdmission;
        throw new Error("finalizer failed");
      },
      logGateway: { ...createSubsystemLogger("test/chat-send-reply-dispatch"), warn },
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
      let unavailable = true;
      const selectedRead = interceptDeliverySnapshot(() => {
        if (unavailable) {
          unavailable = false;
          throw new SessionTranscriptProjectionUnavailableError(scope.sessionId);
        }
      });
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
    "reset",
    "foreign-lifecycle",
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
          } else if (change === "reset") {
            await replaceSessionEntry(scope, {
              sessionId: "replacement-session",
              lifecycleRevision: "replacement",
              updatedAt: 2,
            });
          } else if (change === "foreign-lifecycle") {
            const foreign = new DatabaseSync(resolveSessionTranscriptDatabasePath(scope));
            try {
              foreign
                .prepare(
                  "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.lifecycleRevision', ?) WHERE session_key = ?",
                )
                .run("foreign-replacement", scope.sessionKey);
            } finally {
              foreign.close();
            }
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

  it.each(["new-input", "branch", "answer-rewrite", "unrelated-rewrite", "append"] as const)(
    "retains factual delivery while rechecking a concurrent %s",
    async (change) => {
      await withOpenClawTestState({ label: "webchat-receipt-freshness" }, async () => {
        const { dispatch, append, appendSync, rewriteSync, inputId } =
          await createReplyTranscriptFixture();
        await dispatch.runAgentMediaTranscript(
          { run: async (operation) => operation() },
          async () => {
            dispatch.captureAgentTranscriptStart();
            await append("answer", { role: "assistant", content: "Committed answer." });
            let changed = false;
            const selectedRead = interceptDeliverySnapshot(() => {
              changed = true;
              if (change === "new-input") {
                appendSync("next-input", {
                  role: "user",
                  content: "Inspect the synthetic fixture.",
                  idempotencyKey: "next-input:user",
                });
              } else if (change === "branch" || change === "append") {
                appendSync(
                  "later-answer",
                  { role: "assistant", content: "NO_REPLY" },
                  change === "branch" ? inputId : undefined,
                );
              } else {
                rewriteSync(
                  change === "answer-rewrite" ? "answer" : inputId,
                  change === "answer-rewrite" ? "NO_REPLY" : "Edited input display.",
                );
              }
            });
            try {
              expect(await dispatch.resolveReplyDelivery()).toBe("pending");
              expect(changed).toBe(true);
            } finally {
              selectedRead.mockRestore();
            }
            expect(await dispatch.resolveReplyDelivery()).toBe(
              change === "append" || change === "unrelated-rewrite" ? "delivered" : "missing",
            );
          },
        );
      });
    },
  );
});
