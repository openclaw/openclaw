import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
// @vitest-environment node
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
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

it.each([true, false])(
  "retains blocked text and attachments (connected: %s)",
  async (connected) => {
    const attachment = createStagedAttachment("held-att");
    const host = makeChatHost({
      connected,
      chatMessage: "keep this later draft",
      chatAttachments: [attachment],
      lastError: "Earlier request failed",
      chatError: "Earlier request failed",
      requestHandlers: { "chat.send": { status: "started" } },
      sessionsResult: {
        ...createSessionsListResult(),
        sessions: [
          {
            key: "agent:main",
            kind: "direct",
            sendDisabledReason: "Your operator role requires a sandboxed session.",
          },
        ],
      },
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("keep this later draft");
    expect(host.chatAttachments).toEqual([attachment]);
    expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
    expect(host.chatQueue).toEqual([]);
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    expect(host.chatError).toBe("Earlier request failed");
    expect(host.lastError).toBe("Earlier request failed");
  },
);

it("rechecks send access after settings settle without sending an admitted later turn", async () => {
  const settingsPatch = createDeferred<boolean>();
  const admitted = createDeferred();
  const attachment = createStagedAttachment("waiting-att");
  const row = {
    key: "agent:main",
    kind: "direct" as const,
    sessionId: "pending-settings-test",
    updatedAt: 1,
    sendDisabledReason: null,
  };
  const sendDisabledReason = "Your operator role requires a sandboxed session.";
  const host = makeChatHost({
    chatMessage: "later turn",
    chatAttachments: [attachment],
    requestHandlers: { "chat.send": { status: "started" } },
    pendingSettingsPatches: { "agent:main": settingsPatch.promise },
    sessionsResult: {
      ...createSessionsListResult(),
      sessions: [row],
    },
  });
  const send = handleSendChat(host, undefined, { onOutboxAdmitted: () => admitted.resolve() });
  await admitted.promise;
  const original = host.chatQueue[0]!;
  host.sessions.captureReconcile()({ ...row, updatedAt: 2, sendDisabledReason });
  expect(host.sessions.projectRows([row])[0]?.sendDisabledReason).toBe(sendDisabledReason);
  host.chatMessage = "newer draft";
  settingsPatch.resolve(true);
  await send;

  expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  expect(listStoredChatOutboxes(host)[0]?.queue).toMatchObject([
    {
      id: original.id,
      sendRunId: original.sendRunId,
      attachmentPayload: original.attachmentPayload,
      text: "later turn",
      sendAttempts: 0,
      sendState: "waiting-idle",
    },
  ]);
  expect(host.chatQueue).toMatchObject([
    { id: original.id, text: "later turn", sendAttempts: 0, sendState: "waiting-idle" },
  ]);
  expect(host.chatMessage).toBe("newer draft");
  expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
});

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
