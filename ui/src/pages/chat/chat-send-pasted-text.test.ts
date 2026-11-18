/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { sessionsResult as sessionListFixture } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient as clientWithRequest } from "../../test-helpers/gateway-client.ts";
import { createStagedAttachment } from "./chat-delivery-attachments.test-support.ts";
import {
  createBrowserAnnotationAttachment,
  findChatSendPayload,
  makeChatHost,
  makeRequestMock,
} from "./chat-host.test-support.ts";
import { row } from "./chat-outbox-recovery.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { handleChatAttachmentPaste } from "./components/chat-attachments.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

// Pasted-text cards are composer presentation; submit treats them as typed text.
const pasteCard = (text: string): ChatAttachment => ({
  id: "paste-card",
  mimeType: "text/plain",
  fileName: "pasted-text-1.txt",
  origin: "paste",
  dataUrl: `data:text/plain;base64,${Buffer.from(text).toString("base64")}`,
});
const recipient = (profileId: string, start = 0) => ({ profileId, start, end: start + 5 });

it("appends a pasted-text card after the draft without shifting recipients", async () => {
  const pasted = "  indented paste @Other\n".repeat(80);
  const host = makeChatHost({
    chatMessage: "@Alex please review",
    chatMentions: [recipient("profile-alex")],
    chatAttachments: [
      createBrowserAnnotationAttachment("mention", "@Other context"),
      pasteCard(pasted),
      createStagedAttachment("paste-sibling"),
    ],
    requestHandlers: { "chat.send": { status: "started" } },
  });
  await handleSendChat(host);
  const expected = `@Other context\n\n@Alex please review\n\n${pasted.trimEnd()}`;
  const payload = findChatSendPayload(host);
  expect(payload).toMatchObject({
    message: expected,
    mentions: [recipient("profile-alex", expected.indexOf("@Alex"))],
  });
  // Only real files upload: the annotation screenshot and the PDF, never the paste.
  expect(payload.attachments).toEqual([
    expect.objectContaining({ type: "image" }),
    expect.objectContaining({ fileName: "brief.pdf" }),
  ]);
});

it("keeps a pasted-text card in /steer arguments instead of uploading it", async () => {
  const pasted = "Revised plan line.\n".repeat(80).trimEnd();
  const request = makeRequestMock({
    "chat.send": { status: "started", runId: "steer-paste", messageSeq: 2 },
  });
  const host = makeChatHost({
    client: clientWithRequest(request),
    chatRunId: "run-1",
    chatMessage: "/steer tighten the plan",
    chatAttachments: [pasteCard(pasted)],
    sessionKey: "agent:main:main",
    sessionsResult: {
      ...sessionListFixture(
        [
          row("agent:main:main", {
            activeRunIds: ["run-1"],
            hasActiveRun: true,
            status: "running",
          }),
        ],
        0,
      ),
      path: "",
    },
  });

  await handleSendChat(host);

  const [, params] = request.mock.calls.find(([method]) => method === "chat.send")!;
  expect(params).toMatchObject({ message: `tighten the plan\n\n${pasted}` });
  expect((params as { attachments?: unknown }).attachments).toBeUndefined();
});

it("consumes a pasted-text card when a command retains the composer's files", async () => {
  const pasted = "Background note.\n".repeat(80).trimEnd();
  const file = createStagedAttachment("btw-file");
  const openSessionCompanion = vi.fn();
  const host = makeChatHost({
    requestHandlers: {},
    chatMessage: "/btw explain this",
    chatAttachments: [pasteCard(pasted), file],
    openSessionCompanion,
  });

  await handleSendChat(host);

  expect(openSessionCompanion).toHaveBeenCalledWith(`explain this\n\n${pasted}`);
  expect(host.chatAttachments.map((attachment) => attachment.id)).toEqual([file.id]);
});

it("creates a pasted-text card even when upload limits would reject it as a file", () => {
  const text = "x".repeat(4096);
  const event = new Event("paste", { cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { items: [], files: [], getData: () => text },
  });
  const onAttachmentsChange = vi.fn();

  handleChatAttachmentPaste(event as ClipboardEvent, {
    draft: "Review this",
    attachments: [],
    attachmentLimits: { maxBytes: 1024, maxImageBytes: 1024, maxBatchBytes: 1024 },
    onAttachmentsChange,
  });

  expect(event.defaultPrevented).toBe(true);
  expect(onAttachmentsChange).toHaveBeenCalledWith([
    expect.objectContaining({ origin: "paste", sizeBytes: text.length }),
  ]);
});
