import type { MessageEvent } from "@line/bot-sdk";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Avoid pulling in globals/pairing/media dependencies; this suite only asserts
// allowlist/groupPolicy gating and message-context wiring.
vi.mock("../globals.js", () => ({
  danger: (text: string) => text,
  logVerbose: () => {},
}));

vi.mock("../pairing/pairing-labels.js", () => ({
  resolvePairingIdLabel: () => "lineUserId",
}));

vi.mock("../pairing/pairing-messages.js", () => ({
  buildPairingReply: () => "pairing-reply",
}));

const { downloadLineMediaMock } = vi.hoisted(() => ({
  downloadLineMediaMock: vi.fn(async () => ({
    path: "/tmp/line-media-file.pdf",
    contentType: "application/pdf",
  })),
}));

vi.mock("./download.js", () => ({
  downloadLineMedia: downloadLineMediaMock,
}));

vi.mock("./send.js", () => ({
  pushMessageLine: async () => {
    throw new Error("pushMessageLine should not be called from bot-handlers tests");
  },
  replyMessageLine: async () => {
    throw new Error("replyMessageLine should not be called from bot-handlers tests");
  },
}));

const { buildLineMessageContextMock, buildLinePostbackContextMock } = vi.hoisted(() => ({
  buildLineMessageContextMock: vi.fn(async () => ({
    ctxPayload: { From: "line:group:group-1" },
    replyToken: "reply-token",
    route: { agentId: "default" },
    isGroup: true,
    accountId: "default",
  })),
  buildLinePostbackContextMock: vi.fn(async () => null),
}));

vi.mock("./bot-message-context.js", () => ({
  buildLineMessageContext: buildLineMessageContextMock,
  buildLinePostbackContext: buildLinePostbackContextMock,
  getLineSourceInfo: (source: {
    type?: string;
    userId?: string;
    groupId?: string;
    roomId?: string;
  }) => ({
    userId: source.userId,
    groupId: source.type === "group" ? source.groupId : undefined,
    roomId: source.type === "room" ? source.roomId : undefined,
    isGroup: source.type === "group" || source.type === "room",
  }),
}));

const { readAllowFromStoreMock, upsertPairingRequestMock } = vi.hoisted(() => ({
  readAllowFromStoreMock: vi.fn(async () => [] as string[]),
  upsertPairingRequestMock: vi.fn(async () => ({ code: "CODE", created: true })),
}));

let handleLineWebhookEvents: typeof import("./bot-handlers.js").handleLineWebhookEvents;

const createRuntime = () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: readAllowFromStoreMock,
  upsertChannelPairingRequest: upsertPairingRequestMock,
}));

describe("handleLineWebhookEvents", () => {
  beforeAll(async () => {
    ({ handleLineWebhookEvents } = await import("./bot-handlers.js"));
  });

  beforeEach(() => {
    buildLineMessageContextMock.mockClear();
    buildLinePostbackContextMock.mockClear();
    downloadLineMediaMock.mockClear();
    readAllowFromStoreMock.mockClear();
    upsertPairingRequestMock.mockClear();
  });

  it("blocks group messages when groupPolicy is disabled", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m1", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1", userId: "user-1" },
      mode: "active",
      webhookEventId: "evt-1",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line: { groupPolicy: "disabled" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "disabled" },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("blocks group messages when allowlist is empty", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m2", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1", userId: "user-2" },
      mode: "active",
      webhookEventId: "evt-2",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line: { groupPolicy: "allowlist" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "allowlist" },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("allows group messages when sender is in groupAllowFrom", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m3", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1", userId: "user-3" },
      mode: "active",
      webhookEventId: "evt-3",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: {
        channels: { line: { groupPolicy: "allowlist", groupAllowFrom: ["user-3"] } },
      },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "allowlist", groupAllowFrom: ["user-3"] },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks group sender that is only present in pairing-store allowlist", async () => {
    const processMessage = vi.fn();
    readAllowFromStoreMock.mockResolvedValueOnce(["user-paired"]);
    const event = {
      type: "message",
      message: { id: "m3b", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1", userId: "user-paired" },
      mode: "active",
      webhookEventId: "evt-3b",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: {
        channels: { line: { groupPolicy: "allowlist", groupAllowFrom: ["user-owner"] } },
      },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "allowlist", groupAllowFrom: ["user-owner"] },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("blocks group messages when wildcard group config disables groups", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m4", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-2", userId: "user-4" },
      mode: "active",
      webhookEventId: "evt-4",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line: { groupPolicy: "open" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "open", groups: { "*": { enabled: false } } },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("downloads file attachments and forwards media refs to message context", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "mf-1", type: "file", fileName: "doc.pdf", fileSize: "42" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "user", userId: "user-file" },
      mode: "active",
      webhookEventId: "evt-file-1",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line: {} } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { dmPolicy: "open" },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1234,
      processMessage,
    });

    expect(downloadLineMediaMock).toHaveBeenCalledTimes(1);
    expect(downloadLineMediaMock).toHaveBeenCalledWith("mf-1", "token", 1234);
    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(buildLineMessageContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allMedia: [
          {
            path: "/tmp/line-media-file.pdf",
            contentType: "application/pdf",
          },
        ],
      }),
    );
    expect(processMessage).toHaveBeenCalledTimes(1);
  });
});
