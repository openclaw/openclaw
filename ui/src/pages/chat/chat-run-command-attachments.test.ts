import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as attachmentApi from "./attachment-api.ts";
import { payloads } from "./attachment-payload-lifecycle.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import {
  findPrimaryButton,
  renderComposerFixture,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { createStagedAttachment } from "./chat-delivery-attachments.test-support.ts";
import {
  createBrowserAnnotationAttachment,
  findChatSendPayload,
  makeChatHost,
} from "./chat-host.test-support.ts";
import { requestChatSend } from "./chat-send-request.ts";
import { handleSendChat } from "./chat-send-submit.ts";

const attachmentDataUrl = "data:application/pdf;base64,JVBERi0xLjQK";
const expectedFile = {
  type: "file",
  mimeType: "application/pdf",
  fileName: "brief.pdf",
  content: "JVBERi0xLjQK",
};

afterEach(async () => {
  await resetComposerFixture();
});

function sendComposer(host: ReturnType<typeof makeChatHost>): Promise<unknown> {
  let send: Promise<unknown> | undefined;
  const { container } = renderComposerFixture({
    sessionKey: host.sessionKey,
    draft: host.chatMessage,
    attachments: host.chatAttachments,
    onDraftChange: (draft) => {
      host.chatMessage = draft;
    },
    onSend: () => {
      send = handleSendChat(host);
    },
  });
  const button = findPrimaryButton(container);
  expect(button.disabled).toBe(false);
  button.click();
  if (!send) {
    throw new Error("The composer did not submit");
  }
  return send;
}

describe.each(["steer", "redirect"] as const)("composer /%s attachments", (command) => {
  const draft = `/${command} use this file`;

  it.each(["ok", "started", "in_flight"])(
    "forwards a ready file through Send before retiring it on %s",
    async (status) => {
      const attachment = createStagedAttachment(`command-${command}-${status}`);
      const deleted = vi.spyOn(payloads, "delete");
      const serialize = vi.spyOn(attachmentApi, "buildChatApiAttachments");
      const host = makeChatHost({
        chatMessage: draft,
        chatAttachments: [attachment],
        requestHandlers: { "chat.send": { status, runId: "run-command" } },
      });
      await sendComposer(host);
      expect(host.chatMessage).toBe("");
      expect(host.chatAttachments).toEqual([]);
      expect(getChatAttachmentDataUrl(attachment)).toBeNull();
      expect(deleted.mock.calls.filter(([id]) => id === attachment.id)).toHaveLength(1);
      expect(host.chatError).toBeFalsy();
      expect(serialize).toHaveBeenCalledOnce();
      expect(findChatSendPayload(host)).toMatchObject({
        message: "use this file",
        queueMode: command === "steer" ? "steer" : "interrupt",
        attachments: [expectedFile],
      });
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    },
  );

  it.each(["timeout", "error", "rejected"])(
    "restores the draft and file after %s",
    async (status) => {
      const attachment = createStagedAttachment(`${command}-${status}`);
      const host = makeChatHost({
        chatMessage: draft,
        chatAttachments: [attachment],
        requestHandlers: {
          "chat.send": () => {
            if (status === "rejected") {
              throw new Error("Synthetic rejection");
            }
            return { status, runId: "command-run" };
          },
        },
      });
      await sendComposer(host);
      expect(findChatSendPayload(host)).toMatchObject({ attachments: [expectedFile] });
      expect(host.chatMessage).toBe(draft);
      expect(host.chatAttachments.map((file) => file.id)).toEqual([attachment.id]);
      expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(attachmentDataUrl);
      expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
      expect(host.chatError).toBeTruthy();
    },
  );

  it("preserves a newer draft while a failed request settles", async () => {
    const started = createDeferred();
    const response = createDeferred<{ status: string }>();
    const attachment = createStagedAttachment(`${command}-submitted`);
    const newer = createStagedAttachment(`${command}-newer`);
    const host = makeChatHost({
      chatMessage: draft,
      chatAttachments: [attachment],
      requestHandlers: {
        "chat.send": () => {
          started.resolve();
          return response.promise;
        },
      },
    });
    const send = sendComposer(host);
    await started.promise;
    host.chatMessage = "Newer draft";
    host.chatAttachments = [newer];
    response.resolve({ status: "timeout" });
    await send;
    expect(host.chatMessage).toBe("Newer draft");
    expect(host.chatAttachments).toEqual([newer]);
    expect(getChatAttachmentDataUrl(newer)).toBe(attachmentDataUrl);
    expect(findChatSendPayload(host)).toMatchObject({ attachments: [expectedFile] });
  });

  it("retains failed input under its submitted session after navigation", async () => {
    const started = createDeferred();
    const response = createDeferred<{ status: string }>();
    const attachment = createStagedAttachment(`${command}-navigation`);
    const host = makeChatHost({
      sessionKey: "agent:main:first",
      chatMessage: draft,
      chatAttachments: [attachment],
      requestHandlers: {
        "chat.send": () => {
          started.resolve();
          return response.promise;
        },
      },
    });
    const send = sendComposer(host);
    await started.promise;
    host.sessionKey = "agent:main:second";
    host.chatMessage = "Second session";
    host.chatError = "Second session error";
    response.resolve({ status: "error" });
    await send;
    expect(host.chatMessage).toBe("Second session");
    expect(host.chatError).toBe("Second session error");
    const fallbacks = Object.values(host.chatComposerFallbackByScope);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.message).toBe(draft);
    expect(getChatAttachmentDataUrl(fallbacks[0]!.attachments[0]!)).toBe(attachmentDataUrl);
  });

  it("sends only ordinary files and retains annotations for the next prompt", async () => {
    const file = createStagedAttachment(`${command}-ordinary`);
    const annotation = createBrowserAnnotationAttachment(
      `${command}-annotation`,
      "private annotation context",
    );
    const host = makeChatHost({
      chatMessage: draft,
      chatAttachments: [file, annotation],
      requestHandlers: { "chat.send": { status: "ok" } },
    });
    await sendComposer(host);
    expect(findChatSendPayload(host)).toMatchObject({
      message: "use this file",
      attachments: [expectedFile],
    });
    expect(host.chatAttachments).toEqual([annotation]);
    expect(getChatAttachmentDataUrl(file)).toBeNull();
  });

  it("restores ordinary files alongside retained annotations after rejection", async () => {
    const file = createStagedAttachment(`${command}-annotation-failure`);
    const annotation = createBrowserAnnotationAttachment(
      `${command}-retained-annotation`,
      "annotation context",
    );
    const host = makeChatHost({
      chatMessage: draft,
      chatAttachments: [file, annotation],
      requestHandlers: { "chat.send": { status: "error" } },
    });
    await sendComposer(host);
    expect(host.chatMessage).toBe(draft);
    expect(host.chatAttachments.map((attachment) => attachment.id)).toEqual([
      file.id,
      annotation.id,
    ]);
    expect(getChatAttachmentDataUrl(file)).toBe(attachmentDataUrl);
    expect(findChatSendPayload(host)).toMatchObject({ attachments: [expectedFile] });
  });

  it("keeps an inline command independent of the surrounding composer file", async () => {
    const attachment = createStagedAttachment(`${command}-inline`);
    const host = makeChatHost({
      chatMessage: "Keep this surrounding draft",
      chatAttachments: [attachment],
      requestHandlers: { "chat.send": { status: "ok" } },
    });
    await handleSendChat(host, `/${command} inline correction`);
    expect(findChatSendPayload(host).attachments).toBeUndefined();
    expect(host.chatMessage).toBe("Keep this surrounding draft");
    expect(host.chatAttachments).toEqual([attachment]);
    expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
  });

  it("uses explicit override files without consuming the surrounding draft", async () => {
    const attachment = createStagedAttachment(`${command}-surrounding`);
    const override = createStagedAttachment(`${command}-override`);
    const host = makeChatHost({
      chatMessage: "Keep this surrounding draft",
      chatAttachments: [attachment],
      requestHandlers: { "chat.send": { status: "ok" } },
    });
    await handleSendChat(host, `/${command} explicit correction`, {
      attachmentsOverride: [override],
    });
    expect(findChatSendPayload(host)).toMatchObject({ attachments: [expectedFile] });
    expect(host.chatMessage).toBe("Keep this surrounding draft");
    expect(host.chatAttachments).toEqual([attachment]);
    expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
    expect(getChatAttachmentDataUrl(override)).toBe(attachmentDataUrl);
  });

  it("does not discard a file when the command is missing its required message", async () => {
    const attachment = createStagedAttachment(`${command}-empty`);
    const host = makeChatHost({
      chatMessage: `/${command}`,
      chatAttachments: [attachment],
      requestHandlers: {},
    });
    await sendComposer(host);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
    expect(host.chatMessage).toBe(`/${command}`);
    expect(host.chatAttachments.map((file) => file.id)).toEqual([attachment.id]);
    expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
    expect(host.chatError).toBeTruthy();
  });

  it("rechecks tightened file limits before clearing or sending", async () => {
    vi.useFakeTimers();
    const attachment = createStagedAttachment(`${command}-new-limit`);
    const host = makeChatHost({
      chatMessage: draft,
      chatAttachments: [attachment],
      requestHandlers: { "chat.send": { status: "ok" } },
    });
    if (!host.hello) {
      throw new Error("Missing synthetic Gateway policy");
    }
    host.hello.policy = {
      ...host.hello.policy,
      maxPayload: 100_000,
      attachments: { maxBytes: 1, maxImageBytes: 1 },
    };
    await sendComposer(host);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
    expect(host.chatMessage).toBe(draft);
    expect(host.chatAttachments).toEqual([attachment]);
    expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
  });

  it("does not submit while attachment preparation is pending", () => {
    const onSend = vi.fn();
    const { container } = renderComposerFixture({ draft, pendingAttachmentReads: 1, onSend });
    const button = findPrimaryButton(container);
    expect(button.disabled).toBe(true);
    button.click();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("fails without sending text alone if a retained file payload is unavailable", async () => {
    const attachment = createStagedAttachment(`${command}-missing`);
    payloads.delete(attachment.id);
    const host = makeChatHost({
      chatMessage: draft,
      chatAttachments: [attachment],
      requestHandlers: { "chat.send": { status: "ok" } },
    });
    await handleSendChat(host);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
    expect(host.chatMessage).toBe(draft);
    expect(host.chatAttachments.map((file) => file.id)).toEqual([attachment.id]);
    expect(host.chatError).toBeTruthy();
  });
});

it("keeps the normal chat request on the same existing file serializer", async () => {
  const attachment = createStagedAttachment("normal-chat");
  const host = makeChatHost({
    requestHandlers: { "chat.send": { status: "ok", runId: "ordinary" } },
  });
  await requestChatSend(host, {
    message: "ordinary message",
    attachments: [attachment],
    runId: "ordinary",
  });
  expect(findChatSendPayload(host)).toMatchObject({
    message: "ordinary message",
    attachments: attachmentApi.buildChatApiAttachments([attachment]),
  });
  expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
});

it("does not redirect captured files across a reconnect during the route wait", async () => {
  const attachment = createStagedAttachment("redirect-reconnect");
  const host = makeChatHost({
    chatMessage: "/redirect use this file",
    chatAttachments: [attachment],
    requestHandlers: { "chat.send": { status: "ok" } },
  });
  const send = sendComposer(host);
  host.connectionEpoch += 1;
  await send;
  expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
  expect(host.chatMessage).toBe("/redirect use this file");
  expect(host.chatAttachments).toEqual([attachment]);
  expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
});

it("does not redirect into a session selected during the route wait", async () => {
  const attachment = createStagedAttachment("redirect-route");
  const host = makeChatHost({
    chatMessage: "/redirect use this file",
    chatAttachments: [attachment],
    requestHandlers: { "chat.send": { status: "ok" } },
  });
  const send = sendComposer(host);
  host.sessionKey = "agent:main:other";
  await send;
  expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
  expect(host.chatAttachments).toEqual([attachment]);
  expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
});

it("does not redirect captured files to a newly selected global agent", async () => {
  const attachment = createStagedAttachment("redirect-global-agent");
  const host = makeChatHost({
    sessionKey: "global",
    assistantAgentId: "alpha",
    chatMessage: "/redirect use this file",
    chatAttachments: [attachment],
    requestHandlers: { "chat.send": { status: "ok" } },
  });
  const send = sendComposer(host);
  host.assistantAgentId = "beta";
  await send;
  expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
  expect(host.chatMessage).toBe("/redirect use this file");
  expect(host.chatAttachments).toEqual([attachment]);
  expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
});

it("leaves a newly selected agent's replacement draft and file untouched before dispatch", async () => {
  const attachment = createStagedAttachment("redirect-old-agent");
  const newer = createStagedAttachment("redirect-new-agent");
  const host = makeChatHost({
    sessionKey: "global",
    assistantAgentId: "alpha",
    chatMessage: "/redirect use this file",
    chatAttachments: [attachment],
    requestHandlers: { "chat.send": { status: "ok" } },
  });
  const deleted = vi.spyOn(payloads, "delete");
  const send = sendComposer(host);
  host.assistantAgentId = "beta";
  host.chatMessage = "Beta's new draft";
  host.chatAttachments = [newer];
  await send;
  expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
  expect(host.chatMessage).toBe("Beta's new draft");
  expect(host.chatAttachments).toEqual([newer]);
  expect(getChatAttachmentDataUrl(newer)).toBe(attachmentDataUrl);
  expect(deleted).not.toHaveBeenCalled();
});

describe.each(["steer", "redirect"] as const)("/%s captured ownership", (command) => {
  it.each([
    ["agent", "ok"],
    ["agent", "error"],
    ["agent", "timeout"],
    ["session", "ok"],
    ["session", "error"],
    ["connection", "ok"],
    ["connection", "error"],
  ] as const)(
    "preserves newer %s input after a late %s acknowledgement",
    async (change, status) => {
      const started = createDeferred();
      const response = createDeferred<{ status: string }>();
      const attachment = createStagedAttachment(`${command}-${change}-${status}-old`);
      const newer = createStagedAttachment(`${command}-${change}-${status}-new`);
      const host = makeChatHost({
        sessionKey: "global",
        assistantAgentId: "alpha",
        chatMessage: `/${command} use this file`,
        chatAttachments: [attachment],
        requestHandlers: {
          "chat.send": () => {
            started.resolve();
            return response.promise;
          },
        },
      });
      const deleted = vi.spyOn(payloads, "delete");
      const send = sendComposer(host);
      await started.promise;
      if (change === "agent") {
        host.assistantAgentId = "beta";
      } else if (change === "session") {
        host.sessionKey = "agent:main:other";
      } else {
        host.connectionEpoch += 1;
      }
      host.chatMessage = "Newer input";
      host.chatAttachments = [newer];
      host.chatError = "Newer error";
      response.resolve({ status });
      await send;
      expect(findChatSendPayload(host)).toMatchObject({
        sessionKey: "global",
        agentId: "alpha",
        attachments: [expectedFile],
      });
      expect(host.chatMessage).toBe("Newer input");
      expect(host.chatAttachments).toEqual([newer]);
      expect(host.chatError).toBe("Newer error");
      expect(getChatAttachmentDataUrl(newer)).toBe(attachmentDataUrl);
      expect(deleted.mock.calls.filter(([id]) => id === newer.id)).toHaveLength(0);
      const retainedForRetry = status !== "ok" && change !== "connection";
      expect(deleted.mock.calls.filter(([id]) => id === attachment.id)).toHaveLength(
        retainedForRetry ? 0 : 1,
      );
      if (retainedForRetry) {
        expect(Object.keys(host.chatComposerFallbackByScope)).toEqual(["global\u0000agent:alpha"]);
        const fallback = Object.values(host.chatComposerFallbackByScope)[0]!;
        expect(fallback.message).toBe(`/${command} use this file`);
        expect(getChatAttachmentDataUrl(fallback.attachments[0]!)).toBe(attachmentDataUrl);
      } else {
        expect(getChatAttachmentDataUrl(attachment)).toBeNull();
      }
    },
  );
});
