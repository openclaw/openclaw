// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import * as toast from "../../lib/toast.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import {
  createDeliveryAttachmentBatch,
  createStagedAttachment,
  reloadChatDocumentStorage,
} from "./chat-delivery-attachments.test-support.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  createBrowserAnnotationAttachment,
  createImmediateCommandHost,
  findChatSendPayload,
  makeChatHost,
} from "./chat-host.test-support.ts";
import { retryQueuedChatMessage, resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { getChatSessionProjection } from "./history-merge.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { prepareOutboxPayload } from "./outbox-payloads.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";

const attachmentDataUrl = "data:application/pdf;base64,JVBERi0xLjQK";

useChatSendBrowserFixture();

describe("attachment frame admission", () => {
  const frameLimitedHello = (maxPayload: number) => ({
    ...sessionMutationGatewayHello(),
    policy: { maxPayload, attachments: { maxBytes: 100, maxImageBytes: 100 } },
  });
  const queuedAttachmentBatch = (host: ChatHost) =>
    expectDefined(listStoredChatOutboxes(host)[0]?.queue[0], "stored attachment batch");

  it.each([
    { message: "@Alex review these", chatRunId: null },
    { message: "/approve approval-1 allow-once", chatRunId: "active-run" },
  ])(
    "retains the complete oversized $message draft before transmission",
    async ({ message, chatRunId }) => {
      const { attachments, dataUrls } = createDeliveryAttachmentBatch();
      const mentions = message.startsWith("@")
        ? [{ profileId: "profile-alex", start: 0, end: 5 }]
        : [];
      const replyTarget = { messageId: "reply-source", text: "Earlier question" };
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
      const host = makeChatHost({
        hello: frameLimitedHello(256 * 1024 + 92),
        chatMessage: message,
        chatRunId,
        chatMentions: mentions,
        chatReplyTarget: replyTarget,
        chatAttachments: attachments,
        requestHandlers: { "chat.send": { status: "started" } },
      });

      expect(await handleSendChat(host)).toBeUndefined();

      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
        timeoutMs: 30_000,
      });
      expect(host.chatMessage).toBe(message);
      expect(host.chatMentions).toEqual(mentions);
      expect(host.chatReplyTarget).toEqual(replyTarget);
      expect(host.chatAttachments).toEqual(attachments);
      expect(host.chatAttachments.map(getChatAttachmentDataUrl)).toEqual(dataUrls);
      expect(host.chatQueue).toEqual([]);
      expect(listStoredChatOutboxes(host)).toEqual([]);
      expect(showToast).toHaveBeenCalledExactlyOnceWith({
        message: "Too large to send: brief.pdf",
      });
    },
  );

  it("fails a restored batch under the current frame limit without consuming its payload or retrying", async () => {
    const { attachments, dataUrls } = createDeliveryAttachmentBatch();
    const source = makeChatHost({
      connected: false,
      hello: frameLimitedHello(25 * 1024 * 1024),
      chatMessage: "Review these after reconnect",
      chatAttachments: attachments,
      requestHandlers: {
        "chat.history": {
          messages: [],
          sessionInfo: { key: "agent:main", hasActiveRun: false, status: "done" },
        },
        "chat.send": { status: "started" },
      },
    });
    await handleSendChat(source);
    const original = queuedAttachmentBatch(source);
    expect(original.attachmentPayload).toBeDefined();
    reloadChatDocumentStorage(attachments);
    const restored = makeChatHost({
      client: source.client,
      chatMessage: "Keep this newer draft",
      hello: frameLimitedHello(256 * 1024 + 92),
    });
    const expectedRow = {
      id: original.id,
      sendState: "failed",
      sendError: "Too large to send: brief.pdf",
      sendAttempts: 0,
      attachmentPayload: original.attachmentPayload,
    };

    await resumeStoredChatOutboxes(restored);

    expect(source.request).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
      timeoutMs: 30_000,
    });
    expect(listStoredChatOutboxes(restored)[0]?.queue[0]).toMatchObject(expectedRow);
    expect(restored.chatError).toBe("Too large to send: brief.pdf");

    await retryQueuedChatMessage(restored, original.id);

    expect(source.request).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
      timeoutMs: 30_000,
    });
    const failed = queuedAttachmentBatch(restored);
    expect(failed).toMatchObject(expectedRow);
    const hydrated = await prepareOutboxPayload(restored, failed);
    expect(
      hydrated.status === "ready" ? hydrated.update.attachments?.map(getChatAttachmentDataUrl) : [],
    ).toEqual(dataUrls);
    expect(restored.chatMessage).toBe("Keep this newer draft");
  });
});

describe("structured Goal admission", () => {
  const intent = { kind: "session-goal-start", version: 1, issuedAtMs: 1_788_000_000_000 } as const;

  it("keeps an idle Goal behind an older queued message", async () => {
    const host = makeChatHost({
      chatRunId: "active-run",
      chatMessage: "Start this objective after the queued work",
      requestHandlers: {
        "chat.history": {
          messages: [],
          sessionInfo: { key: "agent:main", hasActiveRun: false, status: "done" },
        },
        "chat.send": { status: "started", runId: "queued-run" },
      },
    });
    await handleSendChat(host, "older queued input", { followUpMode: "queue" });
    host.chatRunId = null;

    await handleSendChat(host, undefined, { intent });

    const sends = host.request.mock.calls.filter(([method]) => method === "chat.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.[1]).toMatchObject({ message: "older queued input" });
    expect(sends[0]?.[1]).not.toHaveProperty("intent");
    expect(host.chatQueue).toContainEqual(
      expect.objectContaining({
        text: "Start this objective after the queued work",
        intent,
        sendAttempts: 0,
      }),
    );
  });

  it.each(["/stop", "  /goal clear\nkeep   this literal  "])(
    "sends %j as an objective without command interpretation",
    async (objective) => {
      const host = makeChatHost({
        chatMessage: objective,
        chatAttachments: [createStagedAttachment("goal-document")],
        chatReplyTarget: {
          messageId: "message-a",
          sourceMessageId: "entry-a",
          text: "Earlier question",
        },
        getWorkContext: () => ({
          page: "chat",
          title: "Ambient context must not become a Goal objective",
        }),
        currentSessionId: "incarnation-a",
        chatDisplayedLeafEntryId: "leaf-a",
        requestHandlers: { "chat.send": { status: "started" } },
      });
      await handleSendChat(host, undefined, { intent });
      expect(findChatSendPayload(host)).toMatchObject({
        message: objective,
        replyToId: "entry-a",
        attachments: [expect.objectContaining({ mimeType: "application/pdf" })],
        intent,
        sessionId: "incarnation-a",
        expectedLeafEntryId: "leaf-a",
      });
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
      expect(host.request.mock.calls.some(([method]) => method === "chat.abort")).toBe(false);
      expect(host.chatMessage).toBe("");
    },
  );

  it.each(["busy", "offline", "annotation"])(
    "preserves the complete draft when %s prevents Goal admission",
    async (reason) => {
      const attachment =
        reason === "annotation"
          ? createBrowserAnnotationAttachment(
              "goal-annotation",
              "Do not append this to the objective",
            )
          : createStagedAttachment(`goal-${reason}`);
      const host = makeChatHost({
        chatMessage: "Keep this objective",
        chatAttachments: [attachment],
        connected: reason !== "offline",
        chatRunId: reason === "busy" ? "existing-run" : null,
        requestHandlers: {},
      });
      await handleSendChat(host, undefined, { intent });
      expect(host.chatMessage).toBe("Keep this objective");
      expect(host.chatAttachments).toEqual([attachment]);
      expect(host.request).not.toHaveBeenCalled();
      expect(host.lastError).toBeTruthy();
    },
  );

  it("restores a rejected objective and retains the original run identity on a stored Retry", async () => {
    let reject = true;
    const goalMode = { action: "start" as const, sessionId: "incarnation-a" };
    const host = makeChatHost({
      chatMessage: "Start this exactly once",
      chatGoalDraftMode: goalMode,
      currentSessionId: "incarnation-a",
      chatDisplayedLeafEntryId: "leaf-a",
      requestHandlers: {
        "chat.send": () => {
          if (reject) {
            throw new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "Goal admission rejected",
            });
          }
          return { status: "started" };
        },
      },
    });
    await handleSendChat(host, undefined, { intent });
    expect(host.chatMessage).toBe("Start this exactly once");
    expect(host.chatGoalDraftMode).toBe(goalMode);

    // Restored outboxes retry an already minted request; they must not mint another run.
    reject = false;
    host.chatGoalDraftMode = null;
    host.chatMessage = "A separate conversation draft";
    const original = findChatSendPayload(host);
    const queued = {
      id: "goal-retry",
      text: "Start this exactly once",
      createdAt: Date.now(),
      intent,
      sessionId: "incarnation-a",
      expectedLeafEntryId: "leaf-a",
      sendRunId: String(original.idempotencyKey),
      sendState: "failed" as const,
      sessionKey: host.sessionKey,
    };
    // The same browser persistence owner used on reconnect restores this immutable row.
    const { admitQueuedMessageForSession } = await import("./chat-queue.ts");
    expect(
      admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, host.sessionKey), queued),
    ).toBe(true);
    host.currentSessionId = "incarnation-b";
    host.chatDisplayedLeafEntryId = "leaf-b";
    await retryQueuedChatMessage(host, queued.id);
    const requests = host.request.mock.calls.filter(([method]) => method === "chat.send");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.[1]).toEqual(original);
    expect(host.chatMessage).toBe("A separate conversation draft");
  });
});

describe("composer recovery", () => {
  it.each(["attachment", "reply", "goal"])(
    "does not mix a failed model-wait draft with a newer %s-only draft",
    async (edit) => {
      const switchUpdate = createDeferred<boolean>();
      const newerAttachment =
        edit === "attachment" ? createStagedAttachment("newer-picker-attachment") : null;
      const newerReply = edit === "reply" ? { messageId: "newer-quote", text: "New quote" } : null;
      const newerGoal = edit === "goal" ? { action: "start" as const } : null;
      const host = makeChatHost({
        requestHandlers: {},
        chatMessage: "keep this send separate",
        pendingSettingsPatches: { "agent:main": switchUpdate.promise },
      });

      const send = handleSendChat(host);
      await Promise.resolve();
      expect(host.chatMessage).toBe("");
      expect(host.chatQueue[0]?.sendState).toBe("waiting-model");
      host.chatAttachments = newerAttachment ? [newerAttachment] : [];
      host.chatReplyTarget = newerReply;
      host.chatGoalDraftMode = newerGoal;

      switchUpdate.resolve(false);
      await send;

      expect(host.request).not.toHaveBeenCalled();
      expect(host.chatMessage).toBe("");
      expect(host.chatAttachments).toEqual(newerAttachment ? [newerAttachment] : []);
      expect(host.chatReplyTarget).toBe(newerReply);
      expect(host.chatGoalDraftMode).toBe(newerGoal);
      expect(host.chatQueue[0]).toMatchObject({
        sendError: "Chat settings update was interrupted. Review and retry when ready.",
        sendState: "failed",
        text: "keep this send separate",
      });
      if (newerAttachment) {
        expect(getChatAttachmentDataUrl(newerAttachment)).toBe(attachmentDataUrl);
      }
    },
  );
});

describe("reply submission", () => {
  it.each([
    {
      message: "continue",
      target: { messageId: "reply-source-1", text: "quoted body", senderLabel: "A *B* [C]" },
      text: "> **A \\*B\\* \\[C\\]:** quoted body\n\ncontinue",
      replyToId: undefined,
      status: "started",
    },
    {
      message: "continue",
      target: {
        messageId: "id:transcript-abc",
        text: "quoted body",
        senderLabel: "Molty",
        sourceMessageId: "transcript-abc",
      },
      text: "continue",
      replyToId: "transcript-abc",
      status: "started",
    },
    {
      message: "retry this",
      target: { messageId: "reply-source-2", text: "quoted body", senderLabel: "User" },
      text: "> **User:** quoted body\n\nretry this",
      replyToId: undefined,
      status: "error",
    },
  ])(
    "transfers $target.messageId to its $status submission",
    async ({ message, target, text, replyToId, status }) => {
      const sent = createDeferred<unknown>();
      const host = makeChatHost({
        requestHandlers: { "chat.send": () => sent.promise },
        chatMessage: message,
        chatReplyTarget: target,
      });
      const send = handleSendChat(host);
      await Promise.resolve();
      expect(host.chatReplyTarget).toBeNull();
      expect(host.chatQueue[0]?.text).toBe(text);
      expect(host.chatQueue[0]?.replyToId).toBe(replyToId);
      sent.resolve({ runId: host.chatQueue[0]?.sendRunId, status });
      await send;
      expect(host.chatReplyTarget).toBeNull();
      expect(host.chatMessage).toBe("");
      if (replyToId) {
        expect(findChatSendPayload(host)).toMatchObject({ message: text, replyToId });
      }
      if (status === "error") {
        expect(host.chatQueue[0]).toMatchObject({ sendState: "failed", text });
      }
    },
  );
});

describe("Home work context admission", () => {
  it.each([
    "queued",
    "included",
    "excluded",
    "/new",
    "/stop",
    "/review-this",
    "!status",
    "stop",
    "",
  ])("captures ambient context only for ordinary input (%j)", async (mode) => {
    const ordinary = ["queued", "included", "excluded"].includes(mode);
    const context = { page: "chat", title: "Original work", sessionKey: "agent:main:parser" };
    const getWorkContext = vi.fn(() => (mode === "excluded" ? undefined : context));
    const message = ordinary ? "Explain this task" : mode;
    const host = makeChatHost({
      connected: mode !== "queued",
      chatMessage: message,
      getWorkContext,
      createChatSession: vi.fn(async () => true),
      requestHandlers: { "chat.send": { status: "started" } },
    });
    await handleSendChat(host);
    if (mode === "queued") {
      context.title = "Later work";
      expect(host.chatQueue).toHaveLength(1);
      expect(host.chatQueue[0]).toMatchObject({
        text: message,
        workContext: { page: "chat", title: "Original work" },
      });
    } else if (ordinary) {
      expect(findChatSendPayload(host).message).toBe(message);
      expect(findChatSendPayload(host).workContext).toEqual(
        mode === "included" ? context : undefined,
      );
      expect(host.chatLocalInputHistoryBySession[host.sessionKey]?.[0]?.text).toBe(message);
    } else {
      expect(getWorkContext).not.toHaveBeenCalled();
      if (mode === "/review-this") {
        expect(findChatSendPayload(host).message).toBe(message);
      }
    }
  });
});

describe("handleSendChat immediate local commands", () => {
  it.each(["draft", "session"])("keeps a newer %s intact when export finishes", async (change) => {
    const exported = createDeferred<"downloaded">();
    const attachment = createStagedAttachment("pending-export-att");
    const exportCurrentChat = vi.fn(() => exported.promise);
    const host = makeChatHost({
      chatMessage: "/export",
      chatAttachments: [attachment],
      exportCurrentChat,
      requestHandlers: {},
    });
    const sending = handleSendChat(host);
    await vi.waitFor(() => expect(exportCurrentChat).toHaveBeenCalledOnce());
    const nextDraft = change === "draft" ? "Keep this new draft" : "/export";
    if (change === "session") {
      host.sessionKey = "agent:main:other";
    }
    host.chatMessage = nextDraft;
    exported.resolve("downloaded");
    await sending;

    expect(host.chatMessage).toBe(nextDraft);
    expect(host.chatAttachments).toEqual([attachment]);
    expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
    expect(host.request).not.toHaveBeenCalled();
  });

  it.each([
    { command: "/export", result: "downloaded" },
    { command: "/export-session", result: "empty" },
  ] as const)(
    "corrects a rejected $command path and handles a $result export",
    async ({ command, result }) => {
      const draft = `${command} reports/conversation.html`;
      const attachment = createStagedAttachment("export-att");
      const exportCurrentChat = vi.fn(() => result);
      const afterCommit = vi.fn(() => () => undefined);
      const host = makeChatHost({
        chatMessage: draft,
        chatAttachments: [attachment],
        exportCurrentChat,
        renderLifecycle: { invalidate: vi.fn(), afterCommit },
        requestHandlers: {},
      });
      await handleSendChat(host);
      expect(exportCurrentChat).not.toHaveBeenCalled();
      expect(host.request).not.toHaveBeenCalled();
      expect(host.chatError).toBe(
        "Control UI exports Markdown through your browser. Run /export without a file path.",
      );
      expect(host.chatMessage).toBe(draft);
      expect(host.chatAttachments).toEqual([attachment]);
      expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
      expect(host.chatQueue).toEqual([]);

      host.chatMessage = command;
      await handleSendChat(host);
      expect(exportCurrentChat).toHaveBeenCalledOnce();
      expect(host.request).not.toHaveBeenCalled();
      expect(host.chatError).toBeNull();
      expect(host.lastError).toBeNull();
      expect(host.chatMessages).toEqual(
        result === "empty"
          ? [
              expect.objectContaining({
                role: "system",
                content: "There are no messages to export yet.",
              }),
            ]
          : [],
      );
      expect(afterCommit).toHaveBeenCalledTimes(result === "empty" ? 1 : 0);
      expect(host.chatMessage).toBe("");
      expect(host.chatAttachments).toEqual([attachment]);
      expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
      expect(host.chatQueue).toStrictEqual([]);
    },
  );

  it.each([true, false])(
    "settles staged attachments when session creation succeeds: %s",
    async (created) => {
      const attachment = createStagedAttachment("new-session-att");
      const attachmentsBySession = new Map<string, ChatAttachment[]>();
      const replyTarget = { messageId: "quoted-before-new", text: "Keep this quote" };
      const host = createImmediateCommandHost("/new", attachment, { chatReplyTarget: replyTarget });
      host.createChatSession = vi.fn(async () => {
        if (!created) {
          return false;
        }
        const previousSessionKey = host.sessionKey;
        const nextSessionKey = "agent:main:new";
        // Capture before switching, as session creation does before the old draft falls back.
        const createdSessionAttachments = [...host.chatAttachments];
        attachmentsBySession.set(previousSessionKey, [...host.chatAttachments]);
        host.sessionKey = nextSessionKey;
        host.chatAttachments = createdSessionAttachments;
        attachmentsBySession.set(nextSessionKey, [...host.chatAttachments]);
        return true;
      });
      await handleSendChat(host);
      expect(host.createChatSession).toHaveBeenCalledOnce();
      if (created) {
        expect(attachmentsBySession.get("agent:main")).toStrictEqual([]);
        expect(attachmentsBySession.get("agent:main:new")).toStrictEqual([]);
        expect(host.chatAttachments).toStrictEqual([]);
      } else {
        expect(host.chatMessage).toBe("/new");
        expect(host.chatReplyTarget).toEqual(replyTarget);
        expect(host.chatAttachments).toHaveLength(1);
        expect(host.chatAttachments[0]).toMatchObject(attachment);
        expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(attachmentDataUrl);
      }
    },
  );
});

describe("handleSendChat session ownership", () => {
  it.each(
    [false, true].flatMap((pendingHistory) =>
      [false, true].map((structured) => ({ pendingHistory, structured })),
    ),
  )(
    "retires the previous run error after local retry (pending history: $pendingHistory, structured: $structured)",
    async ({ pendingHistory, structured }) => {
      const failed: ChatHistoryResult = {
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          status: "failed",
          hasActiveRun: false,
          lastRunId: "run-first",
          lastRunError: "Earlier preparation failed. Retry after repairing the workspace.",
        },
      };
      const refresh = createDeferred<ChatHistoryResult>();
      const history = vi.fn().mockResolvedValueOnce(failed).mockReturnValue(refresh.promise);
      const host = makeChatHost({
        sessionKey: "main",
        chatMessage: "Try again",
        requestHandlers: {
          "chat.history": history,
          "chat.send": { status: "started" },
        },
      });
      await loadChatHistory(host);
      expect(host.chatRunError?.summary).toContain(failed.sessionInfo!.lastRunError);
      const diagnostic = getChatSessionProjection(host).runs["run-first"];
      const loading = pendingHistory ? loadChatHistory(host) : undefined;
      try {
        const sending = handleSendChat(
          host,
          undefined,
          structured
            ? { intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() } }
            : undefined,
        );
        if (!structured) {
          expect(host.chatRunError).toBeNull();
        }
        if (pendingHistory) {
          expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
            timeoutMs: 30_000,
          });
          refresh.resolve(failed);
          await loading;
        }
        await sending;
        const runId = String(findChatSendPayload(host).idempotencyKey);
        expect(host.chatRunId).toBe(runId);
        handleChatGatewayEvent(host, {
          sessionKey: "main",
          runId,
          state: "final",
          message: { role: "assistant", content: "Recovery completed." },
        });

        expect(host.chatMessages.at(-1)).toMatchObject({ content: "Recovery completed." });
        expect(host.chatRunStatus).toMatchObject({ phase: "done", runId });
        expect(host.chatRunId).toBeNull();
        expect(host.lastError).toBeNull();
        expect(getChatSessionProjection(host).runs["run-first"]).toEqual(diagnostic);
        expect(host.chatRunError).toBeNull();
      } finally {
        reconcileChatRunLifecycle(host, { clearRunStatus: true });
      }
    },
  );

  it.each([
    { source: "live", previous: false, status: "failed" },
    { source: "history", previous: false, status: "failed" },
    { source: "history", previous: true, status: "done" },
    { source: "history", previous: true, status: "failed" },
  ] as const)(
    "keeps a $source $status receipt scoped before ACK (previous run: $previous)",
    async ({ source, previous, status }) => {
      const ack = createDeferred<{ status: "started" }>();
      const error = previous ? "Old failure" : "This run failed before its ACK arrived";
      const historyResult = (runId: string): ChatHistoryResult => ({
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          status,
          hasActiveRun: false,
          lastRunId: runId,
          ...(status === "failed" ? { lastRunError: error } : {}),
        },
      });
      const host = makeChatHost({
        sessionKey: "main",
        chatMessage: "A new turn",
        requestHandlers: {
          "chat.send": () => ack.promise,
          ...(previous ? { "chat.history": historyResult("old-run") } : {}),
        },
      });
      const sending = handleSendChat(host);
      try {
        await vi.waitFor(() => expect(findChatSendPayload(host)).toBeDefined());
        const runId = String(findChatSendPayload(host).idempotencyKey);
        if (source === "live") {
          handleChatGatewayEvent(host, {
            sessionKey: "main",
            runId,
            state: "error",
            errorMessage: error,
          });
        } else if (previous) {
          await loadChatHistory(host);
        } else {
          host.request.mockImplementationOnce(async () => historyResult(runId));
          await loadChatHistory(host, { deferBranches: true });
        }
        if (previous) {
          expect(host.chatRunId).toBeNull();
          expect(host.chatRunError).toBeNull();
          expect(getChatSessionProjection(host).runs["old-run"]).toBeUndefined();
        } else {
          const diagnostic = host.chatRunError;
          expect(diagnostic?.summary).toContain(error);
          ack.resolve({ status: "started" });
          await sending;
          expect(host.chatRunId).toBeNull();
          expect(host.chatRunError).toEqual(diagnostic);
        }
      } finally {
        ack.resolve({ status: "started" });
        await sending;
        reconcileChatRunLifecycle(host, { clearRunStatus: true });
      }
    },
  );

  it("holds an offline queue through cold recovery and an awaited history read", async () => {
    const history = createDeferred<unknown>();
    let pending = false;
    const host = makeChatHost({
      connected: false,
      chatMessage: "offline later turn",
      requestHandlers: {
        "chat.history": () => history.promise,
        "chat.send": { status: "started" },
      },
      hasPendingInitialTurn: () => pending,
    });
    const readiness = vi.spyOn(host.client!, "recoveryScopeReady", "get").mockReturnValue(false);
    await handleSendChat(host);
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue).toMatchObject([{ text: "offline later turn", sendAttempts: 0 }]);
    const originalId = host.chatQueue[0]!.sendRunId;
    host.connected = true;
    readiness.mockReturnValue(true);
    const drain = resumeStoredChatOutboxes(host);
    const loading = loadChatHistory(host);
    await vi.waitFor(() =>
      expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything(), {
        timeoutMs: 30_000,
      }),
    );
    readiness.mockReturnValue(false);
    history.resolve({
      messages: [],
      sessionInfo: {
        key: host.sessionKey,
        hasActiveRun: false,
        status: "failed",
        lastRunId: "previous-run",
        lastRunError: "Earlier preparation failed",
      },
    });
    await drain;
    await loading;
    expect(host.chatRunError?.summary).toContain("Earlier preparation failed");
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
      timeoutMs: 30_000,
    });
    expect(host.chatQueue).toMatchObject([
      { text: "offline later turn", sendAttempts: 0, sendRunId: originalId },
    ]);
    pending = true;
    readiness.mockReturnValue(true);
    await resumeStoredChatOutboxes(host);
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything(), {
      timeoutMs: 30_000,
    });
    pending = false;
    await resumeStoredChatOutboxes(host);
    expect(host.chatRunError).toBeNull();
    expect(findChatSendPayload(host)).toMatchObject({
      message: "offline later turn",
      idempotencyKey: originalId,
    });
  });

  it("never drains an offline text submission under a different authenticated account", async () => {
    const host = makeChatHost({
      connected: false,
      chatMessage: "Alice offline input",
      requestHandlers: { "chat.send": { status: "started" } },
    });
    await handleSendChat(host);
    expect(host.chatQueue).toHaveLength(1);
    const scope = vi.spyOn(host.client!, "recoveryScope", "get").mockReturnValue("bob-account");
    host.connected = true;
    await resumeStoredChatOutboxes(host);
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    expect(listStoredChatOutboxes(host)).toEqual([]);
    scope.mockRestore();
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.text).toBe("Alice offline input");
  });
});
