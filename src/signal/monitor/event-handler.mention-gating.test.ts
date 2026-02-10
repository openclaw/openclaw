import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";

let capturedCtx: MsgContext | undefined;

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  const dispatchInboundMessage = vi.fn(async (params: { ctx: MsgContext }) => {
    capturedCtx = params.ctx;
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  });
  return {
    ...actual,
    dispatchInboundMessage,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessage,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessage,
  };
});

import { createSignalEventHandler } from "./event-handler.js";

function createBaseDeps(overrides: Record<string, unknown> = {}) {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    runtime: { log: () => {}, error: () => {} } as any,
    baseUrl: "http://localhost",
    accountId: "default",
    historyLimit: 5,
    groupHistories: new Map(),
    textLimit: 4000,
    dmPolicy: "open" as const,
    allowFrom: ["*"],
    groupAllowFrom: ["*"],
    groupPolicy: "open" as const,
    reactionMode: "off" as const,
    reactionAllowlist: [],
    mediaMaxBytes: 1024,
    ignoreAttachments: true,
    sendReadReceipts: false,
    readReceiptsViaDaemon: false,
    fetchAttachment: async () => null,
    deliverReplies: async () => {},
    resolveSignalReactionTargets: () => [],
    // oxlint-disable-next-line typescript/no-explicit-any
    isSignalReactionMessage: () => false as any,
    shouldEmitSignalReactionNotification: () => false,
    buildSignalReactionSystemEventText: () => "reaction",
    ...overrides,
  };
}

type GroupEventOpts = {
  message?: string;
  attachments?: unknown[];
  quoteText?: string;
};

function makeGroupEvent(opts: GroupEventOpts) {
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15550001111",
        sourceName: "Alice",
        timestamp: 1700000000000,
        dataMessage: {
          message: opts.message ?? "",
          attachments: opts.attachments ?? [],
          quote: opts.quoteText ? { text: opts.quoteText } : undefined,
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      },
    }),
  };
}

describe("signal mention gating", () => {
  it("drops group messages without mention when requireMention is configured", async () => {
    capturedCtx = undefined;
    const handler = createSignalEventHandler(
      createBaseDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@bot"] } },
          channels: { signal: { groups: { "*": { requireMention: true } } } },
        },
      }),
    );

    await handler(makeGroupEvent({ message: "hello everyone" }));
    expect(capturedCtx).toBeUndefined();
  });

  it("allows group messages with mention when requireMention is configured", async () => {
    capturedCtx = undefined;
    const handler = createSignalEventHandler(
      createBaseDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@bot"] } },
          channels: { signal: { groups: { "*": { requireMention: true } } } },
        },
      }),
    );

    await handler(makeGroupEvent({ message: "hey @bot what's up" }));
    expect(capturedCtx).toBeTruthy();
    expect(capturedCtx?.WasMentioned).toBe(true);
  });

  it("sets WasMentioned=false for group messages without mention when requireMention is off", async () => {
    capturedCtx = undefined;
    const handler = createSignalEventHandler(
      createBaseDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@bot"] } },
          channels: { signal: { groups: { "*": { requireMention: false } } } },
        },
      }),
    );

    await handler(makeGroupEvent({ message: "hello everyone" }));
    expect(capturedCtx).toBeTruthy();
    expect(capturedCtx?.WasMentioned).toBe(false);
  });

  it("records pending history for skipped group messages", async () => {
    capturedCtx = undefined;
    const groupHistories = new Map();
    const handler = createSignalEventHandler(
      createBaseDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@bot"] } },
          channels: { signal: { groups: { "*": { requireMention: true } } } },
        },
        historyLimit: 5,
        groupHistories,
      }),
    );

    await handler(makeGroupEvent({ message: "hello from alice" }));
    expect(capturedCtx).toBeUndefined();
    const entries = groupHistories.get("g1");
    expect(entries).toBeTruthy();
    expect(entries).toHaveLength(1);
    expect(entries[0].sender).toBe("Alice");
    expect(entries[0].body).toBe("hello from alice");
  });

  it("records attachment placeholder in pending history for skipped attachment-only group messages", async () => {
    capturedCtx = undefined;
    const groupHistories = new Map();
    const handler = createSignalEventHandler(
      createBaseDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@bot"] } },
          channels: { signal: { groups: { "*": { requireMention: true } } } },
        },
        historyLimit: 5,
        groupHistories,
      }),
    );

    await handler(makeGroupEvent({ message: "", attachments: [{ id: "a1" }] }));
    expect(capturedCtx).toBeUndefined();
    const entries = groupHistories.get("g1");
    expect(entries).toBeTruthy();
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("<media:attachment>");
  });

  it("records quote text in pending history for skipped quote-only group messages", async () => {
    capturedCtx = undefined;
    const groupHistories = new Map();
    const handler = createSignalEventHandler(
      createBaseDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@bot"] } },
          channels: { signal: { groups: { "*": { requireMention: true } } } },
        },
        historyLimit: 5,
        groupHistories,
      }),
    );

    await handler(makeGroupEvent({ message: "", quoteText: "quoted context" }));
    expect(capturedCtx).toBeUndefined();
    const entries = groupHistories.get("g1");
    expect(entries).toBeTruthy();
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("quoted context");
  });

  it("bypasses mention gating for authorized control commands", async () => {
    capturedCtx = undefined;
    const handler = createSignalEventHandler(
      createBaseDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@bot"] } },
          channels: { signal: { groups: { "*": { requireMention: true } } } },
        },
      }),
    );

    await handler(makeGroupEvent({ message: "/help" }));
    expect(capturedCtx).toBeTruthy();
  });
});
