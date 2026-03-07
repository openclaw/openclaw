import type { MessageEvent, PostbackEvent } from "@line/bot-sdk";
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

vi.mock("./download.js", () => ({
  downloadLineMedia: async () => {
    throw new Error("downloadLineMedia should not be called from bot-handlers tests");
  },
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
  buildLinePostbackContextMock: vi.fn(async () => null as unknown),
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
let createLineWebhookReplayCache: typeof import("./bot-handlers.js").createLineWebhookReplayCache;

const createRuntime = () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: readAllowFromStoreMock,
  upsertChannelPairingRequest: upsertPairingRequestMock,
}));

describe("handleLineWebhookEvents", () => {
  beforeAll(async () => {
    ({ handleLineWebhookEvents, createLineWebhookReplayCache } = await import("./bot-handlers.js"));
  });

  beforeEach(() => {
    buildLineMessageContextMock.mockClear();
    buildLinePostbackContextMock.mockClear();
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

  it("blocks group sender not in groupAllowFrom even when sender is paired in DM store", async () => {
    readAllowFromStoreMock.mockResolvedValueOnce(["user-store"]);
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m5", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1", userId: "user-store" },
      mode: "active",
      webhookEventId: "evt-5",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: {
        channels: { line: { groupPolicy: "allowlist", groupAllowFrom: ["user-group"] } },
      },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "allowlist", groupAllowFrom: ["user-group"] },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
    expect(readAllowFromStoreMock).toHaveBeenCalledWith("line", undefined, "default");
  });

  it("does not authorize group messages from DM pairing-store entries when group allowlist is empty", async () => {
    readAllowFromStoreMock.mockResolvedValueOnce(["user-5"]);
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m5b", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1", userId: "user-5" },
      mode: "active",
      webhookEventId: "evt-5b",
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
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
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

  it("scopes DM pairing requests to accountId", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m5", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "user", userId: "user-5" },
      mode: "active",
      webhookEventId: "evt-5",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line: { dmPolicy: "pairing" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { dmPolicy: "pairing", allowFrom: ["user-owner"] },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "line",
        id: "user-5",
        accountId: "default",
      }),
    );
  });

  it("does not authorize DM senders from another account's pairing-store entries", async () => {
    const processMessage = vi.fn();
    readAllowFromStoreMock.mockImplementation(async (...args: unknown[]) => {
      const accountId = args[2] as string | undefined;
      if (accountId === "work") {
        return [];
      }
      return ["cross-account-user"];
    });
    upsertPairingRequestMock.mockResolvedValue({ code: "CODE", created: false });

    const event = {
      type: "message",
      message: { id: "m6", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "user", userId: "cross-account-user" },
      mode: "active",
      webhookEventId: "evt-6",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line: { dmPolicy: "pairing" } } },
      account: {
        accountId: "work",
        enabled: true,
        channelAccessToken: "token-work", // pragma: allowlist secret
        channelSecret: "secret-work", // pragma: allowlist secret
        tokenSource: "config",
        config: { dmPolicy: "pairing" },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(readAllowFromStoreMock).toHaveBeenCalledWith("line", undefined, "work");
    expect(processMessage).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "line",
        id: "cross-account-user",
        accountId: "work",
      }),
    );
  });

  it("deduplicates replayed webhook events by webhookEventId before processing", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m-replay", type: "text", text: "hello" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-replay", userId: "user-replay" },
      mode: "active",
      webhookEventId: "evt-replay-1",
      deliveryContext: { isRedelivery: true },
    } as MessageEvent;

    const context: Parameters<typeof handleLineWebhookEvents>[1] = {
      cfg: { channels: { line: { groupPolicy: "open" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "open" },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
      replayCache: createLineWebhookReplayCache(),
    };

    await handleLineWebhookEvents([event], context);
    await handleLineWebhookEvents([event], context);

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("skips concurrent redeliveries while the first event is still processing", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const processMessage = vi.fn(async () => {
      await firstDone;
    });
    const event = {
      type: "message",
      message: { id: "m-inflight", type: "text", text: "hello" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-inflight", userId: "user-inflight" },
      mode: "active",
      webhookEventId: "evt-inflight-1",
      deliveryContext: { isRedelivery: true },
    } as MessageEvent;

    const context: Parameters<typeof handleLineWebhookEvents>[1] = {
      cfg: { channels: { line: { groupPolicy: "open" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "open" },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
      replayCache: createLineWebhookReplayCache(),
    };

    const firstRun = handleLineWebhookEvents([event], context);
    await Promise.resolve();
    const secondRun = handleLineWebhookEvents([event], context);
    resolveFirst?.();
    await Promise.all([firstRun, secondRun]);

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("mirrors in-flight replay failures so concurrent duplicates also fail", async () => {
    let rejectFirst: ((err: Error) => void) | undefined;
    const firstDone = new Promise<void>((_, reject) => {
      rejectFirst = reject;
    });
    const processMessage = vi.fn(async () => {
      await firstDone;
    });
    const event = {
      type: "message",
      message: { id: "m-inflight-fail", type: "text", text: "hello" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-inflight", userId: "user-inflight" },
      mode: "active",
      webhookEventId: "evt-inflight-fail-1",
      deliveryContext: { isRedelivery: true },
    } as MessageEvent;

    const context: Parameters<typeof handleLineWebhookEvents>[1] = {
      cfg: { channels: { line: { groupPolicy: "open" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "open" },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
      replayCache: createLineWebhookReplayCache(),
    };

    const firstRun = handleLineWebhookEvents([event], context);
    await Promise.resolve();
    const secondRun = handleLineWebhookEvents([event], context);
    rejectFirst?.(new Error("transient inflight failure"));

    await expect(firstRun).rejects.toThrow("transient inflight failure");
    await expect(secondRun).rejects.toThrow("transient inflight failure");
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("deduplicates redeliveries by LINE message id when webhookEventId changes", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m-dup-1", type: "text", text: "hello" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-dup", userId: "user-dup" },
      mode: "active",
      webhookEventId: "evt-dup-1",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    const context: Parameters<typeof handleLineWebhookEvents>[1] = {
      cfg: {
        channels: { line: { groupPolicy: "allowlist", groupAllowFrom: ["user-dup"] } },
      },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "allowlist", groupAllowFrom: ["user-dup"] },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
      replayCache: createLineWebhookReplayCache(),
    };

    await handleLineWebhookEvents([event], context);
    await handleLineWebhookEvents(
      [
        {
          ...event,
          webhookEventId: "evt-dup-redelivery",
          deliveryContext: { isRedelivery: true },
        } as MessageEvent,
      ],
      context,
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("deduplicates postback redeliveries by webhookEventId when replyToken changes", async () => {
    const processMessage = vi.fn();
    buildLinePostbackContextMock.mockResolvedValue({
      ctxPayload: { From: "line:user:user-postback" },
      route: { agentId: "default" },
      isGroup: false,
      accountId: "default",
    });
    const event = {
      type: "postback",
      postback: { data: "action=confirm" },
      replyToken: "reply-token-1",
      timestamp: Date.now(),
      source: { type: "user", userId: "user-postback" },
      mode: "active",
      webhookEventId: "evt-postback-1",
      deliveryContext: { isRedelivery: false },
    } as PostbackEvent;

    const context: Parameters<typeof handleLineWebhookEvents>[1] = {
      cfg: { channels: { line: { dmPolicy: "open" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { dmPolicy: "open" },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
      replayCache: createLineWebhookReplayCache(),
    };

    await handleLineWebhookEvents([event], context);
    await handleLineWebhookEvents(
      [
        {
          ...event,
          replyToken: "reply-token-2",
          deliveryContext: { isRedelivery: true },
        } as PostbackEvent,
      ],
      context,
    );

    expect(buildLinePostbackContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("does not mark replay cache when event processing fails", async () => {
    const processMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce(undefined);
    const event = {
      type: "message",
      message: { id: "m-fail-then-retry", type: "text", text: "hello" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-retry", userId: "user-retry" },
      mode: "active",
      webhookEventId: "evt-fail-then-retry",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    const context: Parameters<typeof handleLineWebhookEvents>[1] = {
      cfg: { channels: { line: { groupPolicy: "open" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "open" },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
      replayCache: createLineWebhookReplayCache(),
    };

    await expect(handleLineWebhookEvents([event], context)).rejects.toThrow("transient failure");
    await handleLineWebhookEvents([event], context);

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(2);
    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(context.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("line: event handler failed: Error: transient failure"),
    );
  });
});
