// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  captureChatOutboxAdmission,
  readStoredOutboxStore,
  storageTargetForGateway,
} from "../../lib/chat/outbox-store.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { createStagedAttachment } from "./chat-delivery-attachments.test-support.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  createBrowserAnnotationAttachment,
  createImmediateCommandHost,
  findChatSendPayload,
  makeChatHost,
} from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { retryQueuedChatMessage, resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { getChatSessionProjection } from "./history-merge.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";

const attachmentDataUrl = "data:application/pdf;base64,JVBERi0xLjQK";

useChatSendBrowserFixture();

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

  it.each(["pause the rollout", "/stop", "  /goal clear\nkeep   this literal  "])(
    "sends %j as an objective without command interpretation",
    async (objective) => {
      const host = makeChatHost({
        chatMessage: objective,
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

  it("keeps attachments and transcript replies separate from the objective", async () => {
    const attachment = createStagedAttachment("goal-document");
    const host = makeChatHost({
      chatMessage: "Review the attached brief",
      chatAttachments: [attachment],
      chatReplyTarget: {
        messageId: "message-a",
        sourceMessageId: "entry-a",
        text: "Earlier question",
      },
      requestHandlers: { "chat.send": { status: "started" } },
    });
    await handleSendChat(host, undefined, { intent });
    expect(findChatSendPayload(host)).toMatchObject({
      message: "Review the attached brief",
      replyToId: "entry-a",
      intent,
      attachments: [expect.objectContaining({ mimeType: "application/pdf" })],
    });
  });

  it("restores a rejected objective and retains the original run identity on a stored Retry", async () => {
    let reject = true;
    const host = makeChatHost({
      chatMessage: "Start this exactly once",
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

    // Restored outboxes retry an already minted request; they must not mint another run.
    reject = false;
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

describe("human mention submission", () => {
  it("keeps only selected recipients after annotation and reply prefixes", async () => {
    const host = makeChatHost({
      chatMessage: "  🔎 @Alex please review  ",
      chatMentions: [{ profileId: "profile-alex", start: 5, end: 10 }],
      chatAttachments: [createBrowserAnnotationAttachment("mention", "Unselected @Other context")],
      chatReplyTarget: {
        messageId: "synthetic-reply",
        text: "Unselected @Other quote",
        senderLabel: "Reader",
      },
      getWorkContext: () => ({ page: "chat", title: "Unselected @Other work context" }),
      requestHandlers: { "chat.send": { status: "started" } },
    });

    await handleSendChat(host);

    const expected =
      "> **Reader:** Unselected @Other quote\n\nUnselected @Other context\n\n🔎 @Alex please review";
    expect(findChatSendPayload(host)).toMatchObject({
      message: expected,
      mentions: [
        {
          profileId: "profile-alex",
          start: expected.indexOf("@Alex"),
          end: expected.indexOf("@Alex") + 5,
        },
      ],
    });
  });

  it("does not clear a same-label replacement recipient while history is loading", async () => {
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      chatMessage: "@Alex please review",
      chatMentions: [{ profileId: "profile-first", start: 0, end: 5 }],
      chatLoading: true,
      currentSessionId: "existing-conversation",
      requestHandlers: {
        "chat.history": () => history.promise,
        "chat.send": { status: "started" },
      },
    });
    const sending = handleSendChat(host);
    await vi.waitFor(() =>
      expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything(), {
        signal: expect.any(AbortSignal),
      }),
    );
    expect(host.chatMessage).toBe("");
    host.chatMessage = "@Alex please review";
    host.chatMentions = [{ profileId: "profile-second", start: 0, end: 5 }];
    history.resolve({
      messages: [],
      sessionInfo: {
        key: host.sessionKey,
        kind: "direct",
        updatedAt: 1,
        status: "done",
        hasActiveRun: false,
      },
    });
    await sending;

    expect(findChatSendPayload(host).mentions).toEqual([
      { profileId: "profile-first", start: 0, end: 5 },
    ]);
    expect(host.chatMessage).toBe("@Alex please review");
    expect(host.chatMentions).toEqual([{ profileId: "profile-second", start: 0, end: 5 }]);
  });

  it.each(["/new @Alex", "/status @Alex", "/btw @Alex review"])(
    "preserves mention intent instead of dropping it in %s",
    async (message) => {
      const mentions = [
        {
          profileId: "profile-alex",
          start: message.indexOf("@Alex"),
          end: message.indexOf("@Alex") + 5,
        },
      ];
      const host = makeChatHost({
        chatMessage: message,
        chatMentions: mentions,
        requestHandlers: {},
      });

      await handleSendChat(host);

      expect(host.request).not.toHaveBeenCalled();
      expect(host.chatMessage).toBe(message);
      expect(host.chatMentions).toEqual(mentions);
      expect(host.chatError).toBeTruthy();
    },
  );
});

describe("Home work context admission", () => {
  it("freezes the context with queued input rather than following navigation", async () => {
    const context = { page: "chat", title: "Original work" };
    const host = makeChatHost({
      connected: false,
      chatMessage: "Review this",
      getWorkContext: () => context,
    });
    await handleSendChat(host);
    context.title = "Later work";
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]).toMatchObject({
      text: "Review this",
      workContext: { page: "chat", title: "Original work" },
    });
  });

  it.each([true, false])(
    "sends an inspectable context only when included (%s)",
    async (included) => {
      const context = {
        page: "chat",
        title: "Review parser",
        sessionKey: "agent:main:parser",
      };
      const host = makeChatHost({
        chatMessage: "Explain this task",
        getWorkContext: () => (included ? context : undefined),
        requestHandlers: { "chat.send": { status: "started" } },
      });
      await handleSendChat(host);
      expect(findChatSendPayload(host).message).toBe("Explain this task");
      expect(findChatSendPayload(host).workContext).toEqual(included ? context : undefined);
      expect(host.chatLocalInputHistoryBySession[host.sessionKey]?.[0]?.text).toBe(
        "Explain this task",
      );
    },
  );

  it.each(["/new", "/stop", "/review-this", "!status", "stop", "停止", ""])(
    "does not attach ambient context to %j",
    async (message) => {
      const getWorkContext = vi.fn(() => ({ page: "chat", title: "Unrelated work context" }));
      const host = makeChatHost({
        chatMessage: message,
        getWorkContext,
        createChatSession: vi.fn(async () => true),
        requestHandlers: { "chat.send": { status: "started" } },
      });
      await handleSendChat(host);
      expect(getWorkContext).not.toHaveBeenCalled();
      if (message === "/review-this") {
        expect(findChatSendPayload(host).message).toBe(message);
      }
    },
  );
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

  it.each(["/export-session", "/export"])(
    "preserves a rejected %s path draft and clears the error after correction",
    async (command) => {
      const draft = `${command} reports/conversation.html`;
      const attachment = createStagedAttachment("export-path-att");
      const exportCurrentChat = vi.fn(() => "downloaded" as const);
      const host = makeChatHost({
        chatMessage: draft,
        chatAttachments: [attachment],
        exportCurrentChat,
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
      expect(host.chatError).toBeNull();
      expect(host.lastError).toBeNull();
      expect(host.chatMessage).toBe("");
      expect(host.chatAttachments).toEqual([attachment]);
    },
  );

  it.each(
    ["/export-session", "/export"].flatMap((command) =>
      (["empty", "downloaded"] as const).map((result) => ({ command, result })),
    ),
  )(
    "handles a $result export and preserves staged attachments for $command",
    async ({ command, result }) => {
      const attachment = createStagedAttachment("export-att");
      const exportCurrentChat = vi.fn(() => result);
      const afterCommit = vi.fn(() => () => undefined);
      const host = makeChatHost({
        chatMessage: command,
        chatAttachments: [attachment],
        exportCurrentChat,
        renderLifecycle: { invalidate: vi.fn(), afterCommit },
        requestHandlers: {},
      });

      await handleSendChat(host);

      expect(exportCurrentChat).toHaveBeenCalledOnce();
      expect(host.request).not.toHaveBeenCalled();
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

  it("does not duplicate staged attachments into both old and new session composers", async () => {
    const attachment = createStagedAttachment("new-session-att");
    const attachmentsBySession = new Map<string, ChatAttachment[]>();
    const host = createImmediateCommandHost("/new", attachment);
    host.createChatSession = vi.fn(async () => {
      const previousSessionKey = host.sessionKey;
      const nextSessionKey = "agent:main:new";
      // Session creation captures the next composer before route switching
      // decides whether the old session's attachment needs a memory fallback.
      const createdSessionAttachments = [...host.chatAttachments];
      attachmentsBySession.set(previousSessionKey, [...host.chatAttachments]);
      host.sessionKey = nextSessionKey;
      host.chatAttachments = createdSessionAttachments;
      attachmentsBySession.set(nextSessionKey, [...host.chatAttachments]);
      return true;
    });

    await handleSendChat(host);

    expect(host.createChatSession).toHaveBeenCalledOnce();
    expect(attachmentsBySession.get("agent:main")).toStrictEqual([]);
    expect(attachmentsBySession.get("agent:main:new")).toStrictEqual([]);
    expect(host.chatAttachments).toStrictEqual([]);
  });

  it("restores staged attachments when creating a new session is cancelled", async () => {
    const attachment = createStagedAttachment("cancelled-new-session-att");
    const createChatSession = vi.fn(async () => false);
    const host = createImmediateCommandHost("/new", attachment, { createChatSession });

    await handleSendChat(host);

    expect(createChatSession).toHaveBeenCalledOnce();
    expect(host.chatMessage).toBe("/new");
    expect(host.chatAttachments).toHaveLength(1);
    expect(host.chatAttachments[0]).toMatchObject(attachment);
    expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(attachmentDataUrl);
  });
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
          expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
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

  it.each(["live", "history"] as const)(
    "does not let an ACK resurrect a run or clear its %s terminal diagnostic",
    async (source) => {
      const ack = createDeferred<{ status: "started" }>();
      const host = makeChatHost({
        sessionKey: "main",
        chatMessage: "Try once",
        requestHandlers: { "chat.send": () => ack.promise },
      });
      const sending = handleSendChat(host);
      try {
        await vi.waitFor(() => expect(findChatSendPayload(host)).toBeDefined());
        const runId = String(findChatSendPayload(host).idempotencyKey);
        const error = "This run failed before its ACK arrived";
        if (source === "live") {
          handleChatGatewayEvent(host, {
            sessionKey: "main",
            runId,
            state: "error",
            errorMessage: error,
          });
        } else {
          host.request.mockImplementationOnce(async () => ({
            messages: [],
            sessionInfo: {
              key: "main",
              kind: "direct",
              updatedAt: 1,
              status: "failed",
              hasActiveRun: false,
              lastRunId: runId,
              lastRunError: error,
            },
          }));
          await loadChatHistory(host, { deferBranches: true });
        }
        const diagnostic = host.chatRunError;
        expect(diagnostic?.summary).toContain(error);
        ack.resolve({ status: "started" });
        await sending;
        expect(host.chatRunId).toBeNull();
        expect(host.chatRunError).toEqual(diagnostic);
      } finally {
        ack.resolve({ status: "started" });
        await sending;
        reconcileChatRunLifecycle(host, { clearRunStatus: true });
      }
    },
  );

  it.each(["done", "failed"] as const)(
    "does not apply older %s history over a pending send",
    async (status) => {
      const ack = createDeferred<{ status: "started" }>();
      const host = makeChatHost({
        sessionKey: "main",
        chatMessage: "A new turn",
        requestHandlers: {
          "chat.send": () => ack.promise,
          "chat.history": {
            messages: [],
            sessionInfo: {
              key: "main",
              kind: "direct",
              updatedAt: 1,
              status,
              hasActiveRun: false,
              lastRunId: "old-run",
              ...(status === "failed" ? { lastRunError: "Old failure" } : {}),
            },
          },
        },
      });
      const sending = handleSendChat(host);
      try {
        await vi.waitFor(() => expect(findChatSendPayload(host)).toBeDefined());
        await loadChatHistory(host);
        expect(host.chatRunId).toBeNull();
        expect(host.chatRunError).toBeNull();
        expect(getChatSessionProjection(host).runs["old-run"]).toBeUndefined();
      } finally {
        ack.resolve({ status: "started" });
        await sending;
        reconcileChatRunLifecycle(host, { clearRunStatus: true });
      }
    },
  );

  it.each(["later turn", ""])(
    "retains %j and attachments until account recovery is ready",
    async (message) => {
      const attachment = createStagedAttachment("cold-att");
      const host = makeChatHost({
        chatMessage: message,
        chatAttachments: [attachment],
        requestHandlers: { "chat.send": { status: "started" } },
        hasPendingInitialTurn: () => false,
      });
      const readiness = vi.spyOn(host.client!, "recoveryScopeReady", "get").mockReturnValue(false);
      await handleSendChat(host);
      expect(host.chatMessage).toBe(message);
      expect(host.chatAttachments).toEqual([attachment]);
      expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
      expect(host.chatQueue).toEqual([]);
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(host.chatError).toBeUndefined();
      expect(host.lastError).toBeNull();
      readiness.mockReturnValue(true);
      await handleSendChat(host);
      expect(findChatSendPayload(host)).toMatchObject({
        message,
        attachments: [expect.objectContaining({ fileName: "brief.pdf" })],
      });
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
      expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything()),
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
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(host.chatQueue).toMatchObject([
      { text: "offline later turn", sendAttempts: 0, sendRunId: originalId },
    ]);
    pending = true;
    readiness.mockReturnValue(true);
    await resumeStoredChatOutboxes(host);
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    pending = false;
    await resumeStoredChatOutboxes(host);
    expect(host.chatRunError).toBeNull();
    expect(findChatSendPayload(host)).toMatchObject({
      message: "offline later turn",
      idempotencyKey: originalId,
    });
  });

  it.each(["initial-turn", "recovery-scope"])(
    "rechecks %s after settings settle without sending an admitted later turn",
    async (hold) => {
      const settingsPatch = createDeferred<boolean>();
      let pending = false;
      const attachment = createStagedAttachment("waiting-att");
      const host = makeChatHost({
        chatMessage: "later turn",
        chatAttachments: [attachment],
        requestHandlers: { "chat.send": { status: "started" } },
        pendingSettingsPatches: { "agent:main": settingsPatch.promise },
        hasPendingInitialTurn: () => pending,
      });
      const send = handleSendChat(host);
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      const original = host.chatQueue[0]!;
      const readiness = vi.spyOn(host.client!, "recoveryScopeReady", "get");
      if (hold === "initial-turn") {
        pending = true;
      } else {
        readiness.mockReturnValue(false);
      }
      host.chatMessage = "newer draft";
      settingsPatch.resolve(true);
      await send;
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      // A connected unresolved owner cannot finish a Blob row's settings write.
      // The stored interrupted-settings state remains paused until explicit retry.
      const sendState = hold === "recovery-scope" ? "failed" : "waiting-idle";
      const retained = Object.values(
        readStoredOutboxStore(sessionStorage, storageTargetForGateway(host.settings?.gatewayUrl))
          .sessions,
      ).flatMap((session) => session.queue ?? []);
      expect(retained).toMatchObject([
        {
          id: original.id,
          sendRunId: original.sendRunId,
          attachmentPayload: original.attachmentPayload,
          text: "later turn",
          sendAttempts: 0,
          sendState,
        },
      ]);
      if (hold === "recovery-scope") {
        expect(retained[0]?.sendError).toBe(
          "Chat settings update was interrupted. Review and retry when ready.",
        );
        expect(host.chatQueue).toEqual([]);
        readiness.mockReturnValue(true);
        chatOutboxOwner(host).syncHost(host);
      }
      expect(host.chatQueue).toMatchObject([
        { id: original.id, text: "later turn", sendAttempts: 0, sendState },
      ]);
      expect(host.chatMessage).toBe("newer draft");
      expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
    },
  );

  it.each([true, false])(
    "retains later text and attachments behind an initial turn (connected: %s)",
    async (connected) => {
      const attachment = createStagedAttachment("held-att");
      const host = makeChatHost({
        connected,
        chatMessage: "keep this later draft",
        chatAttachments: [attachment],
        lastError: "Earlier request failed",
        chatError: "Earlier request failed",
        requestHandlers: { "chat.send": { status: "started" } },
        hasPendingInitialTurn: () => true,
      });
      await handleSendChat(host);
      expect(host.chatMessage).toBe("keep this later draft");
      expect(host.chatAttachments).toEqual([attachment]);
      expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
      expect(host.chatQueue).toEqual([]);
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(host.chatError).toBe("Earlier request failed");
      expect(host.lastError).toBe("Earlier request failed");
    },
  );

  it("keeps the composer intact when no visible session owns the send", async () => {
    const attachment = createStagedAttachment("unscoped-att");
    const request = vi.fn();
    const host = createImmediateCommandHost("keep this draft", attachment, {
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "",
      chatReplyTarget: {
        messageId: "reply-1",
        sourceMessageId: "source-1",
        text: "original message",
      },
    });

    await handleSendChat(host);

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("keep this draft");
    expect(host.chatAttachments).toEqual([attachment]);
    expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
    expect(host.chatReplyTarget).toEqual({
      messageId: "reply-1",
      sourceMessageId: "source-1",
      text: "original message",
    });
    expect(host.chatQueue).toEqual([]);
    expect(host.lastError).toBe("The active session is unavailable; refresh and try again.");
    expect(host.chatError).toBe(host.lastError);
  });
});
