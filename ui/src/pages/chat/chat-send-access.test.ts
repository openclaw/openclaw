import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
// @vitest-environment node
import {
  captureChatOutboxAdmission,
  readStoredOutboxStore,
  storageTargetForGateway,
} from "../../lib/chat/outbox-store.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { createStagedAttachment } from "./chat-delivery-attachments.test-support.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

const attachmentDataUrl = "data:application/pdf;base64,JVBERi0xLjQK";

useChatSendBrowserFixture();

it.each([
  { hold: "access", connected: true, message: "keep this later draft" },
  { hold: "access", connected: false, message: "keep this later draft" },
  { hold: "initial turn", connected: true, message: "keep this later draft" },
  { hold: "initial turn", connected: false, message: "keep this later draft" },
  { hold: "recovery", connected: true, message: "later turn" },
  { hold: "recovery", connected: true, message: "" },
  { hold: "session", connected: true, message: "keep this draft" },
])(
  "retains the composer behind $hold (connected: $connected, text: $message)",
  async ({ hold, connected, message }) => {
    const attachment = createStagedAttachment("held-att");
    const earlierError =
      hold === "access" || hold === "initial turn" ? "Earlier request failed" : undefined;
    const replyTarget =
      hold === "session"
        ? { messageId: "reply-1", sourceMessageId: "source-1", text: "original message" }
        : null;
    const host = makeChatHost({
      connected,
      sessionKey: hold === "session" ? "" : "agent:main",
      chatMessage: message,
      chatAttachments: [attachment],
      chatReplyTarget: replyTarget,
      lastError: earlierError ?? null,
      chatError: earlierError,
      hasPendingInitialTurn: () => hold === "initial turn",
      requestHandlers: { "chat.send": { status: "started" } },
      sessionsResult: {
        ...createSessionsListResult(),
        sessions: [
          {
            key: "agent:main",
            kind: "direct",
            sendDisabledReason:
              hold === "access" ? "Your operator role requires a sandboxed session." : null,
          },
        ],
      },
    });
    const readiness =
      hold === "recovery"
        ? vi.spyOn(host.client!, "recoveryScopeReady", "get").mockReturnValue(false)
        : undefined;
    await handleSendChat(host);
    expect(host.chatMessage).toBe(message);
    expect(host.chatAttachments).toEqual([attachment]);
    expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
    expect(host.chatReplyTarget).toEqual(replyTarget);
    expect(host.chatQueue).toEqual([]);
    expect(host.request).not.toHaveBeenCalled();
    const error =
      hold === "session"
        ? "The active session is unavailable; refresh and try again."
        : earlierError;
    expect(host.chatError).toBe(error);
    expect(host.lastError).toBe(error ?? null);
    if (hold === "recovery") {
      readiness!.mockReturnValue(true);
      await handleSendChat(host);
      expect(findChatSendPayload(host)).toMatchObject({
        message,
        attachments: [expect.objectContaining({ fileName: "brief.pdf" })],
      });
    }
  },
);

it.each(["initial-turn", "recovery-scope", "send-access"])(
  "rechecks %s after settings settle without sending an admitted later turn",
  async (hold) => {
    const settingsPatch = createDeferred<boolean>();
    let pending = false;
    const admitted = createDeferred();
    const row = {
      key: "agent:main",
      kind: "direct" as const,
      sessionId: "pending-settings-test",
      updatedAt: 1,
      sendDisabledReason: null,
    };
    const sendDisabledReason = "Your operator role requires a sandboxed session.";
    const attachment = createStagedAttachment("waiting-att");
    const host = makeChatHost({
      chatMessage: "later turn",
      chatAttachments: [attachment],
      requestHandlers: { "chat.send": { status: "started" } },
      pendingSettingsPatches: { "agent:main": settingsPatch.promise },
      hasPendingInitialTurn: () => pending,
      ...(hold === "send-access"
        ? { sessionsResult: { ...createSessionsListResult(), sessions: [row] } }
        : {}),
    });
    const send = handleSendChat(host, undefined, { onOutboxAdmitted: () => admitted.resolve() });
    await admitted.promise;
    const original = host.chatQueue[0]!;
    const readiness = vi.spyOn(host.client!, "recoveryScopeReady", "get");
    if (hold === "initial-turn") {
      pending = true;
    } else if (hold === "recovery-scope") {
      readiness.mockReturnValue(false);
    } else {
      host.sessions.captureReconcile()({ ...row, updatedAt: 2, sendDisabledReason });
      expect(host.sessions.projectRows([row])[0]?.sendDisabledReason).toBe(sendDisabledReason);
    }
    host.chatMessage = "newer draft";
    settingsPatch.resolve(true);
    await send;
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    // A connected unresolved owner cannot finish a Blob row's settings write.
    // The stored interrupted-settings state remains paused until explicit retry.
    const sendState = hold === "recovery-scope" ? "failed" : "waiting-idle";
    const retained = Object.values(
      readStoredOutboxStore(
        sessionStorage,
        storageTargetForGateway(
          host.settings?.gatewayUrl,
          original.attachmentPayload?.recoveryScope,
        ),
      ).sessions,
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
    if (hold === "send-access") {
      expect(listStoredChatOutboxes(host)[0]?.queue).toMatchObject(retained);
    }
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
  "uses the background global session's send access (blocked: %s)",
  async (blocked) => {
    const writer = {
      key: "global",
      agentId: "writer",
      kind: "global" as const,
      sendDisabledReason: blocked ? "Writer global session is read-only." : null,
    };
    const host = makeChatHost({
      sessionKey: "global",
      assistantAgentId: "main",
      sessionsResultAgentId: "main",
      sessionsResult: {
        ...createSessionsListResult(),
        sessions: [
          {
            key: "global",
            agentId: "main",
            kind: "global",
            sendDisabledReason: blocked ? null : "Main global session is read-only.",
          },
          writer,
        ],
      },
      requestHandlers: {
        "chat.history": { messages: [], sessionInfo: writer },
        "chat.send": { status: "started", runId: "writer-run" },
      },
    });
    const queued = {
      id: "background-writer-input",
      text: "Send to the writer global session",
      createdAt: 1,
      sessionKey: "global",
      agentId: "writer",
      sendRunId: "writer-run",
      sendAttempts: 0,
      sendState: "waiting-idle" as const,
    };
    expect(
      chatOutboxOwner(host).admit(
        host,
        captureChatOutboxAdmission(host, "global", "writer"),
        queued,
      ),
    ).toBe("admitted");

    await resumeStoredChatOutboxes(host);

    if (blocked) {
      expect(host.request).not.toHaveBeenCalled();
      expect(listStoredChatOutboxes(host)[0]?.queue).toMatchObject([queued]);
    } else {
      expect(findChatSendPayload(host)).toMatchObject({
        sessionKey: "global",
        agentId: "writer",
        message: queued.text,
      });
    }
  },
);
