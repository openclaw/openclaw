// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { createStagedAttachment } from "./chat-delivery-attachments.test-support.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { retryQueuedChatMessage } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function createUploadConfig(enabled: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ uploadsEnabled: enabled })),
  );
  const config = createApplicationConfigCapability({ resourceBasePath: "" });
  await config.refresh();
  return config;
}

it("preserves a file draft instead of silently sending only its text", async () => {
  const uploadConfig = await createUploadConfig(false);
  const attachment = createStagedAttachment("disabled-file");
  const host = makeChatHost({
    uploadConfig,
    chatMessage: "Keep the full draft",
    chatAttachments: [attachment],
    requestHandlers: {},
  });
  await handleSendChat(host);
  expect(host.request).not.toHaveBeenCalled();
  expect(host.chatMessage).toBe("Keep the full draft");
  expect(host.chatAttachments).toEqual([attachment]);
  expect(host.lastError).toContain("uploads are disabled");
});

it("fails queued attachment retry visibly after policy changes without discarding its payload", async () => {
  const uploadConfig = await createUploadConfig(true);
  const attachment = createStagedAttachment("queued-file");
  const host = makeChatHost({
    uploadConfig,
    sessionKey: "agent:main:upload-policy",
    chatMessage: "Queued with a file",
    chatAttachments: [attachment],
    chatRunId: "busy",
    requestHandlers: {
      "chat.history": {
        messages: [],
        sessionId: "upload-policy-session",
        sessionInfo: {
          key: "agent:main:upload-policy",
          sessionId: "upload-policy-session",
          hasActiveRun: false,
          status: "done",
        },
      },
    },
  });
  await handleSendChat(host, undefined, { followUpMode: "queue" });
  expect(host.chatQueue).toHaveLength(1);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ uploadsEnabled: false })),
  );
  await uploadConfig.refresh();
  host.chatRunId = null;
  const id = host.chatQueue[0]!.id;
  await retryQueuedChatMessage(host, id);
  expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  expect(host.chatQueue[0]).toMatchObject({
    sendState: "failed",
    sendError: expect.stringContaining("uploads are disabled"),
  });
  expect(host.chatQueue[0]?.attachments).toHaveLength(1);
});
