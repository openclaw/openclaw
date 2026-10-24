import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { buildEmbeddedRunPayloads } from "../../agents/embedded-agent-runner/run/payloads.js";
import { createSubscribedSessionHarness } from "../../agents/embedded-agent-subscribe.e2e-harness.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { observeReplyDelivery } from "../../agents/reply-completion.js";
import { guardSessionManager } from "../../agents/session-tool-result-guard-wrapper.js";
import { sessionManagerReadTranscriptStart } from "../../agents/sessions/session-manager-current-turn.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../agents/stream-message-shared.js";
import {
  copyReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyDispatchOperation } from "../../auto-reply/reply/reply-dispatcher.types.js";
import {
  loadTranscriptEventsSync,
  readActiveTranscriptEntryAnchor,
  resolveSessionTranscriptDatabasePath,
  replaceSessionEntry,
  rewriteTranscriptMessageAtAnchor,
  SessionTranscriptProjectionUnavailableError,
} from "../../config/sessions/session-accessor.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { withSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import { acquireSessionInputActor } from "../../config/sessions/session-input-actor.js";
import * as historyReaders from "../../config/sessions/session-transcript-worker-readers.js";
import {
  runWithoutOwnedSessionTranscriptWrites,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  attachSessionTranscriptRunId,
  emitSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import {
  buildAssistantReplyContentFromInputs,
  extractAssistantDisplayText,
} from "./chat-assistant-content.js";
import {
  buildTranscriptReplyTextFromInputs,
  readChatSendReplyPayload,
  selectChatSendFinalReplyInputs,
} from "./chat-send-command-replies.js";
import {
  createReplyDispatch,
  createReplyTranscriptFixture,
  withReplyTranscript,
} from "./chat-send-reply-dispatch.test-support.js";

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

async function withoutSql(pattern: RegExp, run: () => void | Promise<void>) {
  const sql = observeHostDataSql();
  try {
    const pending = run();
    if (pending) {
      await pending;
    }
    expect(sql.queries.filter((query) => pattern.test(query))).toEqual([]);
  } finally {
    sql.restore();
  }
}

const admission = { run: async <T>(operation: () => Promise<T>) => operation() };
const textBlock = (text: string) => ({ type: "text" as const, text });
const answerMessage = (content: Parameters<typeof buildAssistantMessage>[0]["content"]) =>
  buildAssistantMessage({
    model: { api: "openai-responses", provider: "openai", id: "synthetic" },
    content,
    stopReason: "stop",
    usage: buildUsageWithNoCost({}),
  });
const assistant = (content = "Committed answer.") => ({ role: "assistant", content });
const nextInput = () => ({
  role: "user",
  content: "Inspect the synthetic fixture.",
  idempotencyKey: "next-input:user",
});

describe("chat delivery watermark preparation", () => {
  it.each(["rewrite", "replacement"] as const)(
    "reads released durable reply facts through history and rejects the old answer after %s",
    async (change) => {
      await withReplyTranscript(async ({ dispatch, rewriteSync, scope, runId }) => {
        const acquired = await acquireSessionInputActor(
          {
            ...scope,
            storePath: resolveSessionTranscriptDatabasePath(scope),
            target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
          },
          { assertCurrent() {}, assertReadable() {} },
        );
        assert(acquired, "Expected a durable transcript actor");
        const { actor } = acquired;
        const authority = { assertCurrent() {}, authorize() {} };
        try {
          const before = await actor.read(authority);
          expect(
            dispatch.captureAgentTranscriptStart(runId, {
              ...scope,
              ...before.transcript.watermark,
            }),
          ).toBe(true);
          const appended = await actor.appendToolResult(
            {
              commandId: "assistant-answer",
              phaseId: "turn",
              turn: {
                agentId: scope.agentId,
                sessionKey: scope.sessionKey,
                options: {
                  expectedSessionId: scope.sessionId,
                  sessionFile: "synthetic.jsonl",
                  messages: [
                    {
                      eventId: "answer",
                      message: attachSessionTranscriptRunId(assistant(), runId),
                      now: 2,
                    },
                  ],
                },
              },
            },
            authority,
          );
          expect(appended.kind).toBe("committed");
        } finally {
          await actor.release();
        }
        const anchorReads = vi.fn();
        using _ = interceptDeliverySnapshot(anchorReads);
        await runWithoutOwnedSessionTranscriptWrites(async () => {
          expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
          // Durable append receipts omit full indexes; the history owner supplies anchors.
          expect(anchorReads).toHaveBeenCalledTimes(1);
          if (change === "rewrite") {
            rewriteSync("answer", "NO_REPLY");
          } else {
            await replaceSessionEntry(scope, {
              sessionId: "replacement-session",
              lifecycleRevision: "replacement",
              updatedAt: 3,
            });
          }
          expect(await dispatch.resolveReplyDelivery()).toBe("missing");
          expect(anchorReads).toHaveBeenCalledTimes(change === "rewrite" ? 2 : 1);
        });
      });
    },
  );

  it("consumes the committed manager boundary without caller transcript SQL", async () => {
    await withReplyTranscript(async ({ dispatch, append, scope, runId }) => {
      await append("prior-answer", assistant("Earlier answer."));
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
      await append("current-answer", assistant("Current answer."));
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

  it.each([false, true])(
    "keeps watermark and current-session reads off the Gateway thread (incognito=%s)",
    async (incognito) => {
      await withOpenClawTestState({ label: "chat-watermark-owner" }, async () => {
        const sessionKey = "agent:main:dashboard:incognito-watermark";
        const run = async () => {
          const { dispatch, append } = await createReplyTranscriptFixture(
            incognito ? sessionKey : undefined,
          );
          await dispatch.runAgentMediaTranscript(admission, async () => {
            await withoutSql(/\bfrom\s+"?session_(?:nodes|participants)\b/i, () => {
              dispatch.captureAgentTranscriptStart();
            });
            await append("answer", assistant());
            await withoutSql(
              /\bfrom\s+"?(?:transcript_events|session_nodes|session_participants)\b/i,
              async () => {
                expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
              },
            );
          });
        };
        if (incognito) {
          await withSessionActorStorage(
            { sessionKey, agentId: "main" },
            {
              create: true,
              lifetime: { assertCurrent() {}, assertReadable() {} },
              authority: { assertCurrent() {}, authorize() {} },
            },
            async (binding) => {
              try {
                await run();
              } finally {
                memorySessionActorOwners.closeSession(
                  { agentId: binding.agentId, path: binding.path },
                  sessionKey,
                );
              }
            },
          );
        } else {
          await run();
        }
      });
    },
  );

  it.each(["retired", "aborted", "rejected"] as const)(
    "rechecks %s before consuming the delivery snapshot",
    async (change) => {
      await withReplyTranscript(async ({ dispatch, append, retire, abortController }) => {
        dispatch.captureAgentTranscriptStart();
        await append("answer", assistant());
        let reads = 0;
        const failure = new Error("delivery snapshot read rejected");
        using _ = interceptDeliverySnapshot(() => {
          reads++;
          if (change === "retired") {
            retire();
          } else if (change === "aborted") {
            abortController.abort(failure);
          } else {
            throw failure;
          }
        });
        const delivery = dispatch.resolveReplyDelivery();
        if (change === "rejected" || change === "aborted") {
          await expect(delivery).rejects.toBe(failure);
        } else {
          expect(await delivery).toBe("missing");
        }
        expect(reads).toBe(1);
      }, true);
    },
  );

  it("uses admitted metadata with detached history and refreshes a changed tail", async () => {
    await withReplyTranscript(async ({ dispatch, append, appendSync, scope }) => {
      dispatch.captureAgentTranscriptStart();
      await append("answer", assistant());
      const { databaseClaim } = await loadSessionEntryForAdmission(scope);
      assert(
        "kind" in databaseClaim && databaseClaim.kind === "worker" && databaseClaim.reader,
        "Expected admitted durable session reader",
      );
      try {
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: scope,
            sessionReader: databaseClaim.reader,
            withTranscriptWrite: async (write) => write(),
          },
          async () => {
            expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
            {
              using _ = interceptDeliverySnapshot(() => {
                appendSync("next-input", { role: "user", content: "A new question." });
              });
              expect(await dispatch.resolveReplyDelivery()).toBe("pending");
            }
            expect(await dispatch.resolveReplyDelivery()).toBe("missing");
            await append("next-answer", assistant("The new answer."));
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
  const notice = "Model Fallback: backup/model";
  const answer = "Done.";
  const statusContent = [
    { type: "text", text: notice, openclawStatusNotice: true },
    { type: "text", text: answer },
  ];
  it.each([
    { name: "prepared reasoning only", kind: "prepared", withAnswer: false, fallback: false },
    { name: "raw reasoning and answer", kind: "raw", withAnswer: true, fallback: false },
    { name: "fallback and answer", kind: "raw", withAnswer: true, fallback: true },
  ])("projects $name", async ({ kind, withAnswer, fallback }) => {
    const payloads = fallback
      ? [{ text: notice, isFallbackNotice: true }, { text: answer }]
      : [{ text: "Thinking.", isReasoning: true }, ...(withAnswer ? [{ text: answer }] : [])];
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
        ...(!fallback
          ? {
              agentId: "main",
              transcriptMediaMessage: {
                content: [],
                transcriptText: "",
                payloadTexts: ["Thinking.", "Persisted."],
              },
            }
          : {}),
        inputs,
      }),
    ).toEqual({
      assistantContent: fallback ? statusContent : withAnswer ? [textBlock(answer)] : undefined,
      persistedAssistantContent: fallback
        ? statusContent
        : withAnswer
          ? [textBlock("Persisted.")]
          : undefined,
    });
  });
});

describe("createChatSendReplyDispatch", () => {
  it("owns assistant media before transcript publication only during its live dispatch", async () => {
    let current = true;
    const dispatch = createReplyDispatch("run-media", { isRunCurrent: () => current });
    const rawText =
      "[[reply_to_current]] Artifacts ready\nMEDIA:./artifact.json\n```text\nMEDIA:./example.png\n```";
    const prepare = () =>
      runAgentHarnessBeforeMessageWriteHook({
        message: answerMessage([textBlock(rawText)]),
        prepareAssistantTranscriptMessage: dispatch.prepareAssistantTranscriptMessage,
      });
    expect(projectChatDisplayMessage(prepare())).toMatchObject({
      content: [textBlock(rawText)],
    });
    await dispatch.runAgentMediaTranscript(admission, async () => {
      const persisted = prepare();
      expect(persisted).toMatchObject({
        content: [textBlock(rawText)],
        openclawDelivery: { mediaUrls: ["./artifact.json"] },
      });
      expect(projectChatDisplayMessage(persisted)).toMatchObject({
        content: [
          textBlock("[[reply_to_current]] Artifacts ready\n```text\nMEDIA:./example.png\n```"),
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
    dispatcher.sendToolResult({ text: "tool summary", mediaUrl: "https://example.test/audio.mp3" });
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
      { payload: { text: undefined, mediaUrl: "https://example.test/audio.mp3" }, kind: "final" },
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
    expect(content.assistantContent).toEqual([textBlock(visible)]);
    expect(buildTranscriptReplyTextFromInputs(inputs)).toBe(`[[reply_to:command]]\n${visible}`);
  });

  it.each([
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

      expect.soft(content.assistantContent).toEqual([textBlock(text)]);
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
    dispatcher.sendBlockReply({ text: "[[reply_to_current]] First" });
    await dispatcher.waitForIdle();
    for (const text of ["Second", "NO_REPLY", "NO_REPLY.", "ANNOUNCE_SKIP"]) {
      dispatcher.sendBlockReply({ text });
      await dispatcher.waitForIdle();
    }
    const expected = "First\n\nSecond\n\nNO_REPLY\n\nNO_REPLY.\n\nANNOUNCE_SKIP";
    expect(onCommandBlock).toHaveBeenLastCalledWith(expected);

    onCommandBlock.mockClear();
    dispatcher.sendBlockReply({ text: "hidden reasoning", isReasoning: true });
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
    { phase: "final_answer", text: "NO_REPLY", expected: "delivered" },
    { phase: "final_answer", text: "", expected: "missing" },
  ])(
    "uses committed display answers, not tool progress ($phase, $text)",
    async ({ phase, text, expected }) => {
      await withReplyTranscript(async ({ dispatch, append }) => {
        dispatch.captureAgentTranscriptStart();
        await append("answer", {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            {
              ...textBlock(text),
              ...(phase ? { textSignature: JSON.stringify({ v: 1, id: "answer", phase }) } : {}),
            },
            { type: "toolCall", id: "read-fixture", name: "read", arguments: {} },
          ],
        });
        await append("tool-result", {
          role: "toolResult",
          toolCallId: "read-fixture",
          content: [textBlock("Fixture exists.")],
        });
        await append("silent-terminal", {
          role: "assistant",
          stopReason: "stop",
          content: [textBlock("NO_REPLY")],
        });
        expect(await dispatch.resolveReplyDelivery()).toBe(expected);
      }, true);
    },
  );

  it("retains pending custody when committed answer projection is unavailable", async () => {
    await withReplyTranscript(async ({ dispatch, append, scope }) => {
      dispatch.captureAgentTranscriptStart();
      await append("answer", assistant());
      let unavailable = true;
      using _ = interceptDeliverySnapshot(() => {
        if (unavailable) {
          unavailable = false;
          throw new SessionTranscriptProjectionUnavailableError(scope.sessionId);
        }
      });
      expect(await observeReplyDelivery(dispatch.resolveReplyDelivery, 0, () => {})).toBe(
        "pending",
      );
      expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
    });
  });

  it("requires a committed answer after the current input, not an earlier input or preview", async () => {
    await withReplyTranscript(async ({ dispatch, append, scope, runId }) => {
      await append("prior-answer", assistant("Earlier answer."));
      await dispatch.runAgentMediaTranscript(admission, async () => {
        dispatch.captureAgentTranscriptStart();
        emitSessionTranscriptUpdate({
          target: scope,
          messageId: "uncommitted-answer",
          message: attachSessionTranscriptRunId(assistant("Preview only."), runId),
        });
        expect(await dispatch.resolveReplyDelivery()).toBe("missing");
        await append("first-answer", assistant());
        expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
        // A sealed earlier segment without its next committed input is not authority.
        expect(await dispatch.resolveReplyDelivery(8)).toBe("missing");
        await append("next-input", nextInput());
        expect(await dispatch.resolveReplyDelivery(8)).toBe("missing");
        await append("next-answer", assistant("Next fixture inspected."));
        expect(await dispatch.resolveReplyDelivery(8)).toBe("delivered");
        dispatch.captureAgentTranscriptStart("successor-run");
        await append("retired-run-answer", assistant("Late old-run answer."));
        expect(await dispatch.resolveReplyDelivery()).toBe("missing");
      });
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
    await withReplyTranscript(
      async ({ dispatch, append, scope, inputId, abortController, retire }) => {
        dispatch.captureAgentTranscriptStart();
        await append("answer", assistant());
        expect(await dispatch.resolveReplyDelivery()).toBe("delivered");
        const inFlightReceipt =
          change === "retired" || change === "aborted"
            ? dispatch.resolveReplyDelivery()
            : undefined;
        if (change === "retired") {
          retire();
        } else if (change === "aborted") {
          abortController.abort();
        } else if (change === "lifecycle" || change === "reset") {
          await replaceSessionEntry(scope, {
            sessionId: change === "reset" ? "replacement-session" : scope.sessionId,
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
          await append("other-branch", assistant("NO_REPLY"), inputId);
        } else {
          const anchor = readActiveTranscriptEntryAnchor({
            ...scope,
            entryId: change === "answer-rewrite" ? "answer" : inputId,
          });
          assert(anchor, "Expected active rewrite fixture");
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
      true,
    );
  });

  it.each(["new-input", "branch", "answer-rewrite", "unrelated-rewrite", "append"] as const)(
    "retains factual delivery while rechecking a concurrent %s",
    async (change) => {
      await withReplyTranscript(async ({ dispatch, append, appendSync, rewriteSync, inputId }) => {
        dispatch.captureAgentTranscriptStart();
        await append("answer", assistant());
        let changed = false;
        {
          using _ = interceptDeliverySnapshot(() => {
            changed = true;
            if (change === "new-input") {
              appendSync("next-input", nextInput());
            } else if (change === "branch" || change === "append") {
              appendSync(
                "later-answer",
                assistant("NO_REPLY"),
                change === "branch" ? inputId : undefined,
              );
            } else {
              rewriteSync(
                change === "answer-rewrite" ? "answer" : inputId,
                change === "answer-rewrite" ? "NO_REPLY" : "Edited input display.",
              );
            }
          });
          expect(await dispatch.resolveReplyDelivery()).toBe("pending");
          expect(changed).toBe(true);
        }
        expect(await dispatch.resolveReplyDelivery()).toBe(
          change === "append" || change === "unrelated-rewrite" ? "delivered" : "missing",
        );
      }, true);
    },
  );
});

it.each([
  { replyCount: 1, streaming: false, silentTail: false },
  { replyCount: 2, streaming: true, silentTail: false },
  { replyCount: 1, streaming: false, silentTail: true },
])(
  "enriches $replyCount exact document replies after input projection changes (streaming=$streaming, silentTail=$silentTail)",
  async ({ replyCount, streaming, silentTail }) => {
    await withReplyTranscript(async ({ dispatch, scope, runId, userTurnRecorder }, state) => {
      const filename = state.statePath("media", "contributor-checklist.md");
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, "# Contributor checklist\n- [ ] Run the focused check\n");
      const originals: unknown[] = [];
      await dispatch.runAgentMediaTranscript(admission, async () => {
        dispatch.captureAgentTranscriptStart();
        const capturePrompt = userTurnRecorder.captureModelPromptProjection;
        assert(capturePrompt, "Expected the real user-turn prompt projection owner");
        await capturePrompt("Attached guide contents.\nInspect the synthetic fixture.", () => {});
        const manager = guardSessionManager(await SessionManager.openAsync(scope), {
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          runId,
        });
        const dispatcher = createReplyDispatcher(dispatch.dispatcherOptions);
        const { emit, subscription } = createSubscribedSessionHarness({
          runId,
          blockReplyBreak: "message_end",
          onBlockReply: streaming
            ? (payload) => {
                dispatcher.sendBlockReply(payload);
              }
            : undefined,
        });
        const persist = async (
          message: ReturnType<typeof answerMessage>,
          checkCompleted = false,
        ) => {
          originals.push(structuredClone(message.content));
          emit({ type: "message_start", message });
          emit({ type: "message_end", message });
          await subscription.waitForPendingEvents();
          const completed = subscription.getCurrentAttemptAssistant();
          if (checkCompleted) {
            expect(completed).toBeDefined();
          }
          await manager.appendMessageAsync(message);
          return completed;
        };
        try {
          for (let index = 1; index <= replyCount; index += 1) {
            const text = `Checklist reply ${index}.\nMEDIA:${filename}`;
            const message = answerMessage([
              { ...textBlock(text), textSignature: `signed-answer-${index}` },
            ]);
            const completed = await persist(message, true);
            if (streaming) {
              continue;
            }
            if (silentTail) {
              await persist(answerMessage([]));
              expect(subscription.getKeptAnswer()).toBeDefined();
            }
            const payloads = buildEmbeddedRunPayloads({
              assistantTexts: [text],
              lastAssistant: message,
              currentAssistant: silentTail ? subscription.getCurrentAttemptAssistant() : completed,
              keptAnswer: subscription.getKeptAnswer(),
              assistantMessageIndex: index,
              isCronTrigger: false,
              sessionKey: scope.sessionKey,
              verboseLevel: "off",
              reasoningLevel: "off",
              toolResultFormat: "plain",
            });
            expect(payloads).toHaveLength(1);
            dispatcher.sendFinalReply(payloads[0]!);
          }
        } finally {
          subscription.unsubscribe();
        }
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      });
      const events = loadTranscriptEventsSync(scope).map(asOptionalRecord);
      const assistants = events
        .map((event) => asOptionalRecord(event?.message))
        .filter((message) => message?.role === "assistant");
      expect(assistants).toHaveLength(replyCount + Number(silentTail));
      expect(assistants.map((message) => message?.content)).toEqual(originals);
      for (const message of assistants.slice(0, replyCount)) {
        const display = projectChatDisplayMessage(message);
        const displayContent = display?.content;
        const content = Array.isArray(displayContent) ? displayContent.map(asOptionalRecord) : [];
        expect(content.filter((block) => block?.type === "attachment")).toHaveLength(1);
        expect(JSON.stringify(display)).not.toContain("MEDIA:");
      }
    });
  },
);
