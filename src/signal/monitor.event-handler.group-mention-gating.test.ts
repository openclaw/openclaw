import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchInboundMessageMock = vi.fn();

vi.mock("./send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: vi.fn().mockResolvedValue(true),
  sendReadReceiptSignal: vi.fn().mockResolvedValue(true),
}));

vi.mock("../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: (...args: unknown[]) => dispatchInboundMessageMock(...args),
    dispatchInboundMessageWithDispatcher: (...args: unknown[]) =>
      dispatchInboundMessageMock(...args),
    dispatchInboundMessageWithBufferedDispatcher: (...args: unknown[]) =>
      dispatchInboundMessageMock(...args),
  };
});

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

describe("signal event handler group mention gating", () => {
  beforeEach(() => {
    vi.useRealTimers();
    dispatchInboundMessageMock.mockReset().mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
  });

  it("skips group messages without mention when requireMention is true", async () => {
    vi.resetModules();
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler({
      runtime: { log: () => {}, error: () => {} } as any,
      cfg: {
        messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@clawd"] } },
        channels: {
          signal: {
            groupPolicy: "open",
            allowFrom: ["*"],
            groupAllowFrom: ["*"],
            groups: {
              "test-group-id": {
                requireMention: true,
              },
            },
          },
        },
        agents: {
          list: [
            {
              id: "default",
              identity: { name: "clawd" },
            },
          ],
        },
      } as any,
      baseUrl: "http://localhost",
      account: "+15550009999",
      accountId: "default",
      blockStreaming: false,
      historyLimit: 10,
      groupHistories: new Map(),
      textLimit: 4000,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupAllowFrom: ["*"],
      groupPolicy: "open",
      reactionMode: "off",
      reactionAllowlist: [],
      mediaMaxBytes: 1024,
      ignoreAttachments: true,
      sendReadReceipts: false,
      readReceiptsViaDaemon: false,
      fetchAttachment: async () => null,
      deliverReplies: async () => {},
      resolveSignalReactionTargets: () => [],
      isSignalReactionMessage: () => false as any,
      shouldEmitSignalReactionNotification: () => false,
      buildSignalReactionSystemEventText: () => "reaction",
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello everyone",
            groupInfo: {
              groupId: "test-group-id",
              groupName: "Test Group",
            },
          },
        },
      }),
    });

    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("processes group messages with mention when requireMention is true", async () => {
    vi.resetModules();
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler({
      runtime: { log: () => {}, error: () => {} } as any,
      cfg: {
        messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@clawd"] } },
        channels: {
          signal: {
            groupPolicy: "open",
            allowFrom: ["*"],
            groupAllowFrom: ["*"],
            groups: {
              "test-group-id": {
                requireMention: true,
              },
            },
          },
        },
        agents: {
          list: [
            {
              id: "default",
              identity: { name: "clawd" },
            },
          ],
        },
      } as any,
      baseUrl: "http://localhost",
      account: "+15550009999",
      accountId: "default",
      blockStreaming: false,
      historyLimit: 10,
      groupHistories: new Map(),
      textLimit: 4000,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupAllowFrom: ["*"],
      groupPolicy: "open",
      reactionMode: "off",
      reactionAllowlist: [],
      mediaMaxBytes: 1024,
      ignoreAttachments: true,
      sendReadReceipts: false,
      readReceiptsViaDaemon: false,
      fetchAttachment: async () => null,
      deliverReplies: async () => {},
      resolveSignalReactionTargets: () => [],
      isSignalReactionMessage: () => false as any,
      shouldEmitSignalReactionNotification: () => false,
      buildSignalReactionSystemEventText: () => "reaction",
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          timestamp: 1700000000000,
          dataMessage: {
            message: "@clawd can you help?",
            groupInfo: {
              groupId: "test-group-id",
              groupName: "Test Group",
            },
          },
        },
      }),
    });

    expect(dispatchInboundMessageMock).toHaveBeenCalled();
  });

  it("processes group messages without mention when requireMention is false", async () => {
    vi.resetModules();
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler({
      runtime: { log: () => {}, error: () => {} } as any,
      cfg: {
        messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@clawd"] } },
        channels: {
          signal: {
            groupPolicy: "open",
            allowFrom: ["*"],
            groupAllowFrom: ["*"],
            groups: {
              "test-group-id": {
                requireMention: false,
              },
            },
          },
        },
        agents: {
          list: [
            {
              id: "default",
              identity: { name: "clawd" },
            },
          ],
        },
      } as any,
      baseUrl: "http://localhost",
      account: "+15550009999",
      accountId: "default",
      blockStreaming: false,
      historyLimit: 10,
      groupHistories: new Map(),
      textLimit: 4000,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupAllowFrom: ["*"],
      groupPolicy: "open",
      reactionMode: "off",
      reactionAllowlist: [],
      mediaMaxBytes: 1024,
      ignoreAttachments: true,
      sendReadReceipts: false,
      readReceiptsViaDaemon: false,
      fetchAttachment: async () => null,
      deliverReplies: async () => {},
      resolveSignalReactionTargets: () => [],
      isSignalReactionMessage: () => false as any,
      shouldEmitSignalReactionNotification: () => false,
      buildSignalReactionSystemEventText: () => "reaction",
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello everyone",
            groupInfo: {
              groupId: "test-group-id",
              groupName: "Test Group",
            },
          },
        },
      }),
    });

    expect(dispatchInboundMessageMock).toHaveBeenCalled();
  });

  it("uses wildcard group config when specific group not defined", async () => {
    vi.resetModules();
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler({
      runtime: { log: () => {}, error: () => {} } as any,
      cfg: {
        messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@clawd"] } },
        channels: {
          signal: {
            groupPolicy: "open",
            allowFrom: ["*"],
            groupAllowFrom: ["*"],
            groups: {
              "*": {
                requireMention: true,
              },
            },
          },
        },
        agents: {
          list: [
            {
              id: "default",
              identity: { name: "clawd" },
            },
          ],
        },
      } as any,
      baseUrl: "http://localhost",
      account: "+15550009999",
      accountId: "default",
      blockStreaming: false,
      historyLimit: 10,
      groupHistories: new Map(),
      textLimit: 4000,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupAllowFrom: ["*"],
      groupPolicy: "open",
      reactionMode: "off",
      reactionAllowlist: [],
      mediaMaxBytes: 1024,
      ignoreAttachments: true,
      sendReadReceipts: false,
      readReceiptsViaDaemon: false,
      fetchAttachment: async () => null,
      deliverReplies: async () => {},
      resolveSignalReactionTargets: () => [],
      isSignalReactionMessage: () => false as any,
      shouldEmitSignalReactionNotification: () => false,
      buildSignalReactionSystemEventText: () => "reaction",
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello",
            groupInfo: {
              groupId: "unknown-group-id",
              groupName: "Unknown Group",
            },
          },
        },
      }),
    });

    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("stores group messages without mention in history", async () => {
    vi.resetModules();
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const groupHistories = new Map();
    const handler = createSignalEventHandler({
      runtime: { log: () => {}, error: () => {} } as any,
      cfg: {
        messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@clawd"] } },
        channels: {
          signal: {
            groupPolicy: "open",
            allowFrom: ["*"],
            groupAllowFrom: ["*"],
            groups: {
              "test-group-id": {
                requireMention: true,
              },
            },
          },
        },
        agents: {
          list: [
            {
              id: "default",
              identity: { name: "clawd" },
            },
          ],
        },
      } as any,
      baseUrl: "http://localhost",
      account: "+15550009999",
      accountId: "default",
      blockStreaming: false,
      historyLimit: 10,
      groupHistories,
      textLimit: 4000,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupAllowFrom: ["*"],
      groupPolicy: "open",
      reactionMode: "off",
      reactionAllowlist: [],
      mediaMaxBytes: 1024,
      ignoreAttachments: true,
      sendReadReceipts: false,
      readReceiptsViaDaemon: false,
      fetchAttachment: async () => null,
      deliverReplies: async () => {},
      resolveSignalReactionTargets: () => [],
      isSignalReactionMessage: () => false as any,
      shouldEmitSignalReactionNotification: () => false,
      buildSignalReactionSystemEventText: () => "reaction",
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hello everyone",
            groupInfo: {
              groupId: "test-group-id",
              groupName: "Test Group",
            },
          },
        },
      }),
    });

    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(groupHistories.has("test-group-id")).toBe(true);
    const history = groupHistories.get("test-group-id");
    expect(history).toHaveLength(1);
    expect(history?.[0].body).toBe("hello everyone");
    expect(history?.[0].sender).toBe("Alice");
  });
});
