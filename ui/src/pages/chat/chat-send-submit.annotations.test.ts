// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { composeBrowserAnnotationContext } from "./browser-annotation-context.ts";
import { createStagedAttachment } from "./chat-delivery-attachments.test-support.ts";
import {
  createBrowserAnnotationAttachment,
  findChatSendPayload,
  makeChatHost,
} from "./chat-host.test-support.ts";
import { retryQueuedChatMessage } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

const attachmentDataUrl = "data:application/pdf;base64,JVBERi0xLjQK";

useChatSendBrowserFixture();

describe("composeBrowserAnnotationContext", () => {
  it("preserves attachment order across two annotations", () => {
    const first = createBrowserAnnotationAttachment("first", "First context");
    const second = createBrowserAnnotationAttachment("second", "Second context");

    expect(composeBrowserAnnotationContext("Compare them", [first, second])).toBe(
      "First context\n\nSecond context\n\nCompare them",
    );
  });
});

describe("handleSendChat browser annotation context", () => {
  it("sends an annotation without requiring user-authored text", async () => {
    const attachment = createBrowserAnnotationAttachment("annotation-only", "Inspect this page");
    const host = makeChatHost({
      requestHandlers: { "chat.send": { runId: "annotation-only-run", status: "started" } },
      chatAttachments: [attachment],
    });

    await handleSendChat(host);

    expect(findChatSendPayload(host).message).toBe("Inspect this page");
  });

  it("routes /new before materializing annotation context", async () => {
    const attachment = createBrowserAnnotationAttachment("slash", "Review the annotated page");
    const createChatSession = vi.fn(async () => true);
    const host = makeChatHost({
      requestHandlers: {},
      chatAttachments: [attachment],
      chatMessage: "/new",
      createChatSession,
    });

    vi.spyOn(host.client!, "recoveryScopeReady", "get").mockReturnValue(false);
    await handleSendChat(host);

    expect(createChatSession).toHaveBeenCalledOnce();
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
  });

  it.each(["/stop", "stop", "esc", "abort", "wait", "exit"])(
    "routes active-run stop intent %s before materializing annotation context",
    async (command) => {
      const attachment = createBrowserAnnotationAttachment("stop", "Review the annotated page");
      const host = makeChatHost({
        requestHandlers: { "chat.abort": { aborted: true } },
        chatAttachments: [attachment],
        chatMessage: command,
        chatRunId: "annotation-stop-run",
      });

      vi.spyOn(host.client!, "recoveryScopeReady", "get").mockReturnValue(false);
      await handleSendChat(host);

      expect(host.request).toHaveBeenCalledWith("chat.abort", {
        runId: "annotation-stop-run",
        sessionKey: "agent:main",
      });
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    },
  );

  it.each([
    ["/side", ""],
    ["/btw", ""],
    ["/side", "explain this"],
    ["/btw", "explain this"],
  ])(
    "opens companion intent %s %s without sending annotation context",
    async (command, question) => {
      const attachment = createBrowserAnnotationAttachment("companion", "Review the page");
      const openSessionCompanion = vi.fn();
      const host = makeChatHost({
        requestHandlers: {},
        chatAttachments: [attachment],
        chatMessage: `${command} ${question}`.trim(),
        openSessionCompanion,
      });

      await handleSendChat(host);

      expect(openSessionCompanion).toHaveBeenCalledWith(question);
      expect(host.chatMessage).toBe("");
      expect(host.chatLocalInputHistoryBySession[host.sessionKey]?.[0]?.text).toBe(
        `${command} ${question}`.trim(),
      );
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    },
  );

  it("keeps annotation context on natural stop words when no run is active", async () => {
    const attachment = createBrowserAnnotationAttachment("idle-stop", "Review the page");
    const host = makeChatHost({
      requestHandlers: { "chat.send": { runId: "annotation-idle-run", status: "started" } },
      chatAttachments: [attachment],
      chatMessage: "wait",
    });

    await handleSendChat(host);

    expect(findChatSendPayload(host).message).toBe("Review the page\n\nwait");
    expect(host.request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
  });

  it.each(["browser", "selection"])(
    "preserves %s annotations across remote commands until the next actual model prompt",
    async (kind) => {
      const annotation: ChatAttachment =
        kind === "browser"
          ? createBrowserAnnotationAttachment("remote", "Review the annotated page")
          : {
              id: "selection-remote",
              mimeType: "text/plain",
              fileName: "selection-annotation.txt",
              dataUrl: `data:text/plain;base64,${Buffer.from("Selected text:\nReview the deployment checklist.").toString("base64")}`,
              selectionAnnotation: {
                text: "Review the deployment checklist.",
                comment: "",
                sessionKey: "agent:main",
                messageId: "assistant-1",
                start: 0,
                end: 32,
              },
            };
      const document = createStagedAttachment("remote-document");
      const host = makeChatHost({
        requestHandlers: { "chat.send": { runId: "annotation-command-run", status: "ok" } },
        chatAttachments: [annotation, document],
        chatMessage: "/status",
      });

      await handleSendChat(host);

      const command = findChatSendPayload(host);
      expect(command.message).toBe("/status");
      expect(command.attachments).toEqual([
        expect.objectContaining({ fileName: "brief.pdf", mimeType: "application/pdf" }),
      ]);
      expect(host.chatAttachments).toEqual([annotation]);
      expect(host.chatQueue).toEqual([]);

      host.request.mockClear();
      host.chatMessage = "Explain the highlighted issue";
      await handleSendChat(host);

      const modelPrompt = findChatSendPayload(host);
      expect(modelPrompt.message).toBe(
        kind === "browser"
          ? "Review the annotated page\n\nExplain the highlighted issue"
          : "Explain the highlighted issue",
      );
      expect(modelPrompt.attachments).toEqual([
        expect.objectContaining({
          mimeType: kind === "browser" ? "image/png" : "text/plain",
        }),
      ]);
      expect(host.chatAttachments).toEqual([]);
    },
  );

  it("retains annotations while forwarding an active-run approval with its ordinary file", async () => {
    const annotation = createBrowserAnnotationAttachment("approval", "Review the annotated page");
    const document = createStagedAttachment("approval-document");
    const host = makeChatHost({
      requestHandlers: { "chat.send": { runId: "approval-command-run", status: "started" } },
      chatAttachments: [annotation, document],
      chatMessage: "/approve approval-123 allow-once",
      chatRunId: "active-run",
      chatStream: "Waiting for approval...",
    });

    vi.spyOn(host.client!, "recoveryScopeReady", "get").mockReturnValue(false);
    await handleSendChat(host);

    const command = findChatSendPayload(host);
    expect(command.message).toBe("/approve approval-123 allow-once");
    expect(command.attachments).toEqual([
      expect.objectContaining({ fileName: "brief.pdf", mimeType: "application/pdf" }),
    ]);
    expect(host.chatAttachments).toEqual([annotation]);
    expect(host.chatMessage).toBe("");
  });

  it.each(["/status", "/approve approval-123 allow-once"])(
    "restores the command draft and mixed attachments when %s fails",
    async (command) => {
      const annotation = createBrowserAnnotationAttachment("failed-command", "Review the page");
      const document = createStagedAttachment("failed-command-document");
      const approval = command.startsWith("/approve");
      const host = makeChatHost({
        requestHandlers: { "chat.send": { runId: "failed-command-run", status: "error" } },
        chatAttachments: [annotation, document],
        chatMessage: command,
        chatRunId: approval ? "active-run" : null,
        chatStream: approval ? "Waiting for approval..." : null,
      });

      await handleSendChat(host);

      expect(findChatSendPayload(host).attachments).toEqual([
        expect.objectContaining({ fileName: "brief.pdf", mimeType: "application/pdf" }),
      ]);
      expect(host.chatMessage).toBe(command);
      expect(host.chatAttachments).toMatchObject([
        {
          id: annotation.id,
          browserAnnotation: annotation.browserAnnotation,
          dataUrl: annotation.dataUrl,
        },
        { id: document.id, fileName: "brief.pdf", dataUrl: attachmentDataUrl },
      ]);
      expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(annotation.dataUrl);
      expect(getChatAttachmentDataUrl(host.chatAttachments[1]!)).toBe(attachmentDataUrl);
    },
  );

  it("never restores over a replacement annotation that reuses the submitted attachment ID", async () => {
    const acknowledgment = createDeferred<{ runId: string; status: "error" }>();
    const annotation = createBrowserAnnotationAttachment("reused-annotation", "Original page");
    const replacement = {
      ...annotation,
      dataUrl: "data:image/png;base64,bmV3",
      browserAnnotation: {
        ...annotation.browserAnnotation!,
        modelContext: "Replacement page",
      },
    };
    const host = makeChatHost({
      requestHandlers: { "chat.send": () => acknowledgment.promise },
      chatAttachments: [annotation],
      chatMessage: "/approve approval-123 allow-once",
      chatRunId: "active-run",
      chatStream: "Waiting for approval...",
    });

    const send = handleSendChat(host);
    await vi.waitFor(() => expect(host.request).toHaveBeenCalledOnce());
    expect(host.chatMessage).toBe("");
    host.chatAttachments = [replacement];
    acknowledgment.resolve({ runId: "failed-approval-run", status: "error" });
    await send;

    expect(host.chatMessage).toBe("");
    expect(host.chatAttachments).toEqual([replacement]);
    expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(replacement.dataUrl);
  });

  it("never restores a failed approval over a newer composer attachment", async () => {
    const acknowledgment = createDeferred<{ runId: string; status: "error" }>();
    const annotation = createBrowserAnnotationAttachment("stale-approval", "Review the page");
    const replacement = createBrowserAnnotationAttachment("replacement", "Review the newer page");
    const host = makeChatHost({
      requestHandlers: { "chat.send": () => acknowledgment.promise },
      chatAttachments: [annotation],
      chatMessage: "/approve approval-123 allow-once",
      chatRunId: "active-run",
      chatStream: "Waiting for approval...",
    });

    const send = handleSendChat(host);
    await vi.waitFor(() => expect(host.request).toHaveBeenCalledOnce());
    host.chatMessage = "Newer operator draft";
    host.chatAttachments = [replacement];
    acknowledgment.resolve({ runId: "failed-approval-run", status: "error" });
    await send;

    expect(host.chatMessage).toBe("Newer operator draft");
    expect(host.chatAttachments).toEqual([replacement]);
  });

  it("materializes annotation context for unrecognized slash-prefixed input", async () => {
    const attachment = createBrowserAnnotationAttachment("unknown", "Review the annotated page");
    const host = makeChatHost({
      requestHandlers: { "chat.send": { runId: "annotation-model-run", status: "started" } },
      chatAttachments: [attachment],
      chatMessage: "/review-this",
    });

    await handleSendChat(host);

    expect(findChatSendPayload(host).message).toBe("Review the annotated page\n\n/review-this");
  });

  it.each(["annotation", "home"])(
    "keeps one %s context snapshot through delayed delivery and retry",
    async (source) => {
      const settingsPatch = createDeferred<boolean>();
      const sendRequest = vi
        .fn()
        .mockResolvedValueOnce({ status: "timeout" })
        .mockResolvedValue({ status: "started" });
      let workContext = "Stable browser context";
      const attachment = createBrowserAnnotationAttachment("delayed", "Stable browser context");
      const replacement = createBrowserAnnotationAttachment("replacement", "New browser context");
      const mentions = [{ profileId: "profile-alex", start: 5, end: 10 }];
      const host = makeChatHost({
        requestHandlers: { "chat.send": sendRequest },
        chatAttachments: source === "annotation" ? [attachment] : [],
        getWorkContext: source === "home" ? () => workContext : undefined,
        chatMessage: "  🔎 @Alex Use the marked area  ",
        chatMentions: mentions,
        pendingSettingsPatches: { "agent:main": settingsPatch.promise },
      });

      // Annotation context is prepended by the attachment path; Home work context
      // trails the message so session titles derive from what the person asked.
      const expected =
        source === "home"
          ? "🔎 @Alex Use the marked area\n\nStable browser context"
          : "Stable browser context\n\n🔎 @Alex Use the marked area";
      const expectedMentions = [
        {
          profileId: "profile-alex",
          start: expected.indexOf("@Alex"),
          end: expected.indexOf("@Alex") + 5,
        },
      ];

      const send = handleSendChat(host);
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      expect(host.chatQueue[0]?.text).toBe(expected);
      expect(host.chatQueue[0]?.mentions).toEqual(expectedMentions);
      expect(host.chatMentions).toEqual([]);

      mentions[0]!.profileId = "not-the-submitted-recipient";
      host.chatMessage = "@Carol New draft";
      host.chatMentions = [{ profileId: "profile-carol", start: 0, end: 6 }];
      host.chatAttachments = [replacement];
      workContext = "A different task is now visible";
      settingsPatch.resolve(true);
      await send;

      expect(findChatSendPayload(host).message).toBe(expected);
      expect(findChatSendPayload(host).mentions).toEqual(expectedMentions);
      expect(host.chatQueue[0]).toMatchObject({ sendState: "failed", text: expected });
      expect(host.chatMessage).toBe("@Carol New draft");
      expect(host.chatMentions).toEqual([{ profileId: "profile-carol", start: 0, end: 6 }]);
      expect(host.chatAttachments).toEqual([replacement]);
      expect(host.chatLocalInputHistoryBySession[host.sessionKey]?.[0]?.text).toBe(
        "🔎 @Alex Use the marked area",
      );
      await retryQueuedChatMessage(host, host.chatQueue[0]!.id);
      expect(sendRequest.mock.calls.map(([params]) => params.message)).toEqual([
        expected,
        expected,
      ]);
      expect(sendRequest.mock.calls.map(([params]) => params.mentions)).toEqual([
        expectedMentions,
        expectedMentions,
      ]);
    },
  );
});
