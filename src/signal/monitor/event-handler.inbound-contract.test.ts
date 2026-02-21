import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectInboundContextContract } from "../../../test/helpers/inbound-contract.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { SignalEventHandlerDeps, SignalReactionMessage } from "./event-handler.types.js";
let capturedCtx: MsgContext | undefined;
let capturedCtxs: MsgContext[] = [];

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  const dispatchInboundMessage = vi.fn(async (params: { ctx: MsgContext }) => {
    capturedCtx = params.ctx;
    capturedCtxs.push(params.ctx);
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

function createTestHandler(overrides: Partial<SignalEventHandlerDeps> = {}) {
  return createSignalEventHandler({
    // oxlint-disable-next-line typescript/no-explicit-any
    runtime: { log: () => {}, error: () => {} } as any,
    // oxlint-disable-next-line typescript/no-explicit-any
    cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
    baseUrl: "http://localhost",
    accountId: "default",
    historyLimit: 0,
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
    injectLinkPreviews: true,
    preserveTextStyles: true,
    fetchAttachment: async () => null,
    deliverReplies: async () => {},
    resolveSignalReactionTargets: () => [],
    isSignalReactionMessage: (
      _reaction: SignalReactionMessage | null | undefined,
    ): _reaction is SignalReactionMessage => false,
    shouldEmitSignalReactionNotification: () => false,
    buildSignalReactionSystemEventText: () => "reaction",
    ...overrides,
  });
}

function makeReceiveEvent(
  dataMessage: Record<string, unknown>,
  envelope: Record<string, unknown> = {},
) {
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15550001111",
        sourceName: "Alice",
        timestamp: 1700000000000,
        dataMessage: {
          message: "",
          attachments: [],
          ...dataMessage,
        },
        ...envelope,
      },
    }),
  };
}

beforeEach(() => {
  capturedCtx = undefined;
  capturedCtxs = [];
});

describe("signal createSignalEventHandler inbound contract", () => {
  it("passes a finalized MsgContext to dispatchInboundMessage", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "hi",
        groupInfo: { groupId: "g1", groupName: "Test Group" },
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx!);
    const contextWithBody = capturedCtx as unknown as { Body?: string };
    // Sender should appear as prefix in group messages (no redundant [from:] suffix)
    expect(String(contextWithBody.Body ?? "")).toContain("Alice");
    expect(String(contextWithBody.Body ?? "")).toMatch(/Alice.*:/);
    expect(String(contextWithBody.Body ?? "")).not.toContain("[from:");
  });

  it("normalizes direct chat To/OriginatingTo targets to canonical Signal ids", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent(
        {
          message: "hello",
        },
        {
          sourceNumber: "+15550002222",
          sourceName: "Bob",
          timestamp: 1700000000001,
        },
      ),
    );

    expect(capturedCtx).toBeTruthy();
    const context = capturedCtx as unknown as {
      ChatType?: string;
      To?: string;
      OriginatingTo?: string;
    };
    expect(context.ChatType).toBe("direct");
    expect(context.To).toBe("+15550002222");
    expect(context.OriginatingTo).toBe("+15550002222");
  });

  it("maps all attachments to plural media fields and preserves first-item aliases", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      const id = params.attachment?.id;
      if (id === "att-1") {
        return { path: "/tmp/signal-att-1.jpg", contentType: "image/jpeg" };
      }
      if (id === "att-2") {
        return { path: "/tmp/signal-att-2.png", contentType: "image/png" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        attachments: [
          { id: "att-1", contentType: "image/jpeg" },
          { id: "att-2", contentType: "image/png" },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx!);
    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    expect(capturedCtx?.MediaPath).toBe("/tmp/signal-att-1.jpg");
    expect(capturedCtx?.MediaType).toBe("image/jpeg");
    expect(capturedCtx?.MediaUrl).toBe("/tmp/signal-att-1.jpg");
    expect(capturedCtx?.MediaPaths).toEqual(["/tmp/signal-att-1.jpg", "/tmp/signal-att-2.png"]);
    expect(capturedCtx?.MediaUrls).toEqual(["/tmp/signal-att-1.jpg", "/tmp/signal-att-2.png"]);
    expect(capturedCtx?.MediaTypes).toEqual(["image/jpeg", "image/png"]);
  });

  it("keeps media type array aligned with media paths when content type is missing", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      const id = params.attachment?.id;
      if (id === "att-1") {
        return { path: "/tmp/signal-att-1.bin" };
      }
      if (id === "att-2") {
        return { path: "/tmp/signal-att-2.png", contentType: "image/png" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        attachments: [{ id: "att-1" }, { id: "att-2", contentType: "image/png" }],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(capturedCtx?.MediaPaths).toEqual(["/tmp/signal-att-1.bin", "/tmp/signal-att-2.png"]);
    expect(capturedCtx?.MediaTypes).toEqual(["application/octet-stream", "image/png"]);
    expect(capturedCtx?.MediaType).toBe("application/octet-stream");
  });

  it("keeps successful attachments when one attachment fetch fails", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      const id = params.attachment?.id;
      if (id === "att-1") {
        throw new Error("network timeout");
      }
      if (id === "att-2") {
        return { path: "/tmp/signal-att-2.png", contentType: "image/png" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        attachments: [
          { id: "att-1", contentType: "image/jpeg" },
          { id: "att-2", contentType: "image/png" },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    expect(capturedCtx?.MediaPaths).toEqual(["/tmp/signal-att-2.png"]);
    expect(capturedCtx?.MediaPath).toBe("/tmp/signal-att-2.png");
    expect(capturedCtx?.MediaType).toBe("image/png");
  });

  it("maps quote metadata to reply context fields", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "reply with quote",
        quote: {
          id: 9001,
          text: "original message",
          authorUuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx!);
    expect(capturedCtx?.ReplyToId).toBe("9001");
    expect(capturedCtx?.ReplyToSender).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(capturedCtx?.ReplyToBody).toBe("original message");
    expect(capturedCtx?.ReplyToIsQuote).toBe(true);
  });

  it("falls back quote reply metadata to timestamp and author number", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "reply with quote",
        quote: {
          timestamp: 1700000000111,
          text: "fallback author message",
          authorNumber: "+15550002222",
          author: "fallback",
        },
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx!);
    expect(capturedCtx?.ReplyToId).toBe("1700000000111");
    expect(capturedCtx?.ReplyToSender).toBe("+15550002222");
    expect(capturedCtx?.ReplyToBody).toBe("fallback author message");
    expect(capturedCtx?.ReplyToIsQuote).toBe(true);
  });

  it("sets reply body to undefined when quoted text is missing", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "reply with empty quote",
        quote: {
          id: 9002,
          text: "   ",
          authorUuid: "123e4567-e89b-12d3-a456-426614174001",
        },
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(capturedCtx?.ReplyToId).toBe("9002");
    expect(capturedCtx?.ReplyToSender).toBe("123e4567-e89b-12d3-a456-426614174001");
    expect(capturedCtx?.ReplyToBody).toBeUndefined();
    expect(capturedCtx?.ReplyToIsQuote).toBe(true);
  });

  it("clears quote and untrusted metadata when debounced entries are merged", async () => {
    const handler = createTestHandler({
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: { inbound: { debounceMs: 50 } } } as any,
    });

    await handler(makeReceiveEvent({ message: "first message" }));
    await handler(
      makeReceiveEvent({
        message: "second message",
        quote: { id: 42, text: "quoted" },
        previews: [{ url: "https://example.com", title: "Example", description: "Desc" }],
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 90));

    expect(capturedCtxs).toHaveLength(1);
    expect(capturedCtx?.BodyForCommands).toBe("first message\\nsecond message");
    expect(capturedCtx?.ReplyToId).toBeUndefined();
    expect(capturedCtx?.ReplyToBody).toBeUndefined();
    expect(capturedCtx?.ReplyToSender).toBeUndefined();
    expect(capturedCtx?.ReplyToIsQuote).toBeUndefined();
    expect(capturedCtx?.UntrustedContext).toBeUndefined();
  });

  it("handles sticker messages with sticker placeholder, downloaded media, and metadata", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      const id = params.attachment?.id;
      if (id === "sticker-att-1") {
        return { path: "/tmp/signal-sticker-1.webp", contentType: "image/webp" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        sticker: {
          packId: "signal-pack-1",
          stickerId: 42,
          attachment: {
            id: "sticker-att-1",
            contentType: "image/webp",
          },
        },
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx!);
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    expect(capturedCtx?.BodyForCommands).toBe("<media:sticker>");
    expect(capturedCtx?.MediaPath).toBe("/tmp/signal-sticker-1.webp");
    expect(capturedCtx?.MediaType).toBe("image/webp");
    expect(capturedCtx?.MediaUrl).toBe("/tmp/signal-sticker-1.webp");
    expect(capturedCtx?.MediaPaths).toEqual(["/tmp/signal-sticker-1.webp"]);
    expect(capturedCtx?.MediaUrls).toEqual(["/tmp/signal-sticker-1.webp"]);
    expect(capturedCtx?.MediaTypes).toEqual(["image/webp"]);
    expect(capturedCtx?.UntrustedContext).toContain("Signal sticker packId: signal-pack-1");
    expect(capturedCtx?.UntrustedContext).toContain("Signal stickerId: 42");
  });

  it("annotates explicit voice notes and uses voice-aware audio placeholder", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      if (params.attachment?.id === "voice-att-1") {
        return { path: "/tmp/signal-voice-1.ogg", contentType: "audio/ogg" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        attachments: [
          {
            id: "voice-att-1",
            contentType: "audio/ogg",
            filename: "voice-note.ogg",
            voiceNote: true,
          },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx!);
    expect(capturedCtx?.BodyForCommands).toBe("<media:audio> (voice note)");
    expect(capturedCtx?.UntrustedContext).toContain("Signal voice note attachment indexes: 1");
  });

  it("infers voice notes from filename hints when voiceNote flag is absent", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      if (params.attachment?.id === "voice-att-2") {
        return { path: "/tmp/signal-voice-2.ogg", contentType: "audio/ogg" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        attachments: [
          {
            id: "voice-att-2",
            contentType: "application/octet-stream",
            filename: "ptt-00001.ogg",
          },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx!);
    expect(capturedCtx?.BodyForCommands).toBe("<media:audio> (voice note)");
    expect(capturedCtx?.UntrustedContext).toContain("Signal voice note attachment indexes: 1");
  });

  it("does not classify plain audio/ogg as a voice note without explicit hints", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      if (params.attachment?.id === "audio-att-1") {
        return { path: "/tmp/signal-audio-1.ogg", contentType: "audio/ogg" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        attachments: [
          {
            id: "audio-att-1",
            contentType: "audio/ogg",
            filename: "recording.ogg",
          },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(capturedCtx?.BodyForCommands).toBe("<media:audio>");
    const untrusted = capturedCtx?.UntrustedContext?.join("\n") ?? "";
    expect(untrusted).not.toContain("voice note");
  });

  it("passes attachment dimensions into media context fields", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      if (params.attachment?.id === "img-att-1") {
        return { path: "/tmp/signal-img-1.jpg", contentType: "image/jpeg" };
      }
      if (params.attachment?.id === "img-att-2") {
        return { path: "/tmp/signal-img-2.png", contentType: "image/png" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        attachments: [
          {
            id: "img-att-1",
            contentType: "image/jpeg",
            width: 4000,
            height: 3000,
          },
          {
            id: "img-att-2",
            contentType: "image/png",
            width: 1920,
            height: 1080,
          },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx!);
    expect(capturedCtx?.MediaDimension).toEqual({ width: 4000, height: 3000 });
    expect(capturedCtx?.MediaDimensions).toEqual([
      { width: 4000, height: 3000 },
      { width: 1920, height: 1080 },
    ]);
  });

  it("threads attachment captions into media caption context fields", async () => {
    const fetchAttachment = vi.fn(async (params: { attachment?: { id?: string | null } }) => {
      if (params.attachment?.id === "img-cap-1") {
        return { path: "/tmp/signal-cap-1.jpg", contentType: "image/jpeg" };
      }
      if (params.attachment?.id === "img-cap-2") {
        return { path: "/tmp/signal-cap-2.png", contentType: "image/png" };
      }
      return null;
    });

    const handler = createTestHandler({
      ignoreAttachments: false,
      fetchAttachment,
    });

    await handler(
      makeReceiveEvent({
        attachments: [
          {
            id: "img-cap-1",
            contentType: "image/jpeg",
            caption: "sunset",
          },
          {
            id: "img-cap-2",
            contentType: "image/png",
            caption: "mountain",
          },
        ],
      }),
    );

    const ctx = capturedCtx as MsgContext & {
      MediaCaption?: string;
      MediaCaptions?: string[];
    };
    expect(ctx).toBeTruthy();
    expect(ctx.MediaCaption).toBe("sunset");
    expect(ctx.MediaCaptions).toEqual(["sunset", "mountain"]);
  });

  it("tracks edit target timestamp for edited messages", async () => {
    const handler = createTestHandler();

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          timestamp: 1700000000999,
          editMessage: {
            targetSentTimestamp: 1700000000111,
            dataMessage: {
              message: "edited text",
              attachments: [],
            },
          },
        },
      }),
    });

    const ctx = capturedCtx as MsgContext & {
      EditTargetTimestamp?: number;
    };
    expect(ctx).toBeTruthy();
    expect(ctx.EditTargetTimestamp).toBe(1700000000111);
    expect(ctx.BodyForCommands).toBe("edited text");
  });

  it("adds link preview metadata to untrusted context", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "check this",
        previews: [
          {
            url: "https://example.com/post",
            title: "Example Post",
            description: "A useful summary",
          },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(capturedCtx?.UntrustedContext).toContain(
      "Link preview: Example Post - A useful summary (https://example.com/post)",
    );
  });

  it("formats signal text styles into markdown in the message body", async () => {
    const handler = createTestHandler();

    await handler(
      makeReceiveEvent({
        message: "hello world",
        textStyles: [
          { style: "BOLD", start: 0, length: 5 },
          { style: "ITALIC", start: 6, length: 5 },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(capturedCtx?.BodyForCommands).toBe("**hello** _world_");
  });

  it("skips link preview injection when injectLinkPreviews is false", async () => {
    const handler = createTestHandler({
      injectLinkPreviews: false,
    });

    await handler(
      makeReceiveEvent({
        message: "check this",
        previews: [
          {
            url: "https://example.com/post",
            title: "Example Post",
            description: "A useful summary",
          },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    const untrusted = capturedCtx?.UntrustedContext?.join("\n") ?? "";
    expect(untrusted).not.toContain("Link preview");
    expect(untrusted).not.toContain("https://example.com/post");
  });

  it("skips text style formatting when preserveTextStyles is false", async () => {
    const handler = createTestHandler({
      preserveTextStyles: false,
    });

    await handler(
      makeReceiveEvent({
        message: "hello world",
        textStyles: [
          { style: "BOLD", start: 0, length: 5 },
          { style: "ITALIC", start: 6, length: 5 },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(capturedCtx?.BodyForCommands).toBe("hello world");
    expect(capturedCtx?.BodyForCommands).not.toContain("**");
    expect(capturedCtx?.BodyForCommands).not.toContain("_");
  });

  it("applies link previews and text styles by default when toggles are undefined", async () => {
    // Create handler with deps that have undefined toggles (mimicking runtime behavior)
    const handler = createSignalEventHandler({
      // oxlint-disable-next-line typescript/no-explicit-any
      runtime: { log: () => {}, error: () => {} } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
      baseUrl: "http://localhost",
      accountId: "default",
      historyLimit: 0,
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
      // Intentionally pass undefined to test default behavior
      injectLinkPreviews: undefined,
      preserveTextStyles: undefined,
      fetchAttachment: async () => null,
      deliverReplies: async () => {},
      resolveSignalReactionTargets: () => [],
      isSignalReactionMessage: (
        _reaction: SignalReactionMessage | null | undefined,
      ): _reaction is SignalReactionMessage => false,
      shouldEmitSignalReactionNotification: () => false,
      buildSignalReactionSystemEventText: () => "reaction",
    });

    await handler(
      makeReceiveEvent({
        message: "hello world",
        textStyles: [
          { style: "BOLD", start: 0, length: 5 },
          { style: "ITALIC", start: 6, length: 5 },
        ],
        previews: [
          {
            url: "https://example.com",
            title: "Example",
            description: "Test",
          },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    // Text styles should be applied (default true)
    expect(capturedCtx?.BodyForCommands).toBe("**hello** _world_");
    // Link previews should be in untrusted context (default true)
    const untrusted = capturedCtx?.UntrustedContext?.join("\n") ?? "";
    expect(untrusted).toContain("Link preview: Example - Test (https://example.com)");
  });

  it("applies link previews and text styles when explicitly set to true", async () => {
    const handler = createTestHandler({
      injectLinkPreviews: true,
      preserveTextStyles: true,
    });

    await handler(
      makeReceiveEvent({
        message: "hello world",
        textStyles: [
          { style: "MONOSPACE", start: 0, length: 5 },
          { style: "STRIKETHROUGH", start: 6, length: 5 },
        ],
        previews: [
          {
            url: "https://test.com/page",
            title: "Test Page",
          },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    // Text styles should be applied
    expect(capturedCtx?.BodyForCommands).toBe("`hello` ~~world~~");
    // Link previews should be in untrusted context
    const untrusted = capturedCtx?.UntrustedContext?.join("\n") ?? "";
    expect(untrusted).toContain("Link preview: Test Page (https://test.com/page)");
  });

  it("preserveTextStyles: false does not affect link preview injection", async () => {
    const handler = createTestHandler({
      preserveTextStyles: false,
      injectLinkPreviews: true,
    });

    await handler(
      makeReceiveEvent({
        message: "check this out",
        textStyles: [{ style: "BOLD", start: 0, length: 5 }],
        previews: [
          {
            url: "https://independent.com",
            title: "Independent Test",
          },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    // Text styles should NOT be applied
    expect(capturedCtx?.BodyForCommands).toBe("check this out");
    expect(capturedCtx?.BodyForCommands).not.toContain("**");
    // Link previews SHOULD still be injected
    const untrusted = capturedCtx?.UntrustedContext?.join("\n") ?? "";
    expect(untrusted).toContain("Link preview: Independent Test (https://independent.com)");
  });

  it("injectLinkPreviews: false does not affect text style formatting", async () => {
    const handler = createTestHandler({
      injectLinkPreviews: false,
      preserveTextStyles: true,
    });

    await handler(
      makeReceiveEvent({
        message: "styled text",
        textStyles: [
          { style: "BOLD", start: 0, length: 6 },
          { style: "ITALIC", start: 7, length: 4 },
        ],
        previews: [
          {
            url: "https://should-not-appear.com",
            title: "Should Not Appear",
          },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    // Text styles SHOULD be applied
    expect(capturedCtx?.BodyForCommands).toBe("**styled** _text_");
    // Link previews should NOT be injected
    const untrusted = capturedCtx?.UntrustedContext?.join("\n") ?? "";
    expect(untrusted).not.toContain("Link preview");
    expect(untrusted).not.toContain("https://should-not-appear.com");
  });

  it("injectLinkPreviews: false with no previews does not cause errors", async () => {
    const handler = createTestHandler({
      injectLinkPreviews: false,
    });

    await handler(
      makeReceiveEvent({
        message: "plain message with no previews",
        // No previews field at all
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(capturedCtx?.BodyForCommands).toBe("plain message with no previews");
    // UntrustedContext should be undefined or not contain link previews
    expect(capturedCtx?.UntrustedContext).toBeUndefined();
  });

  it("preserveTextStyles: false with no text styles does not cause errors", async () => {
    const handler = createTestHandler({
      preserveTextStyles: false,
    });

    await handler(
      makeReceiveEvent({
        message: "plain message",
        // No textStyles field at all
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(capturedCtx?.BodyForCommands).toBe("plain message");
  });

  it("both toggles false with no data does not cause errors", async () => {
    const handler = createTestHandler({
      injectLinkPreviews: false,
      preserveTextStyles: false,
    });

    await handler(
      makeReceiveEvent({
        message: "completely plain message",
        // No previews, no textStyles
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(capturedCtx?.BodyForCommands).toBe("completely plain message");
    expect(capturedCtx?.UntrustedContext).toBeUndefined();
  });

  it("both toggles false with data present still processes message correctly", async () => {
    const handler = createTestHandler({
      injectLinkPreviews: false,
      preserveTextStyles: false,
    });

    await handler(
      makeReceiveEvent({
        message: "message with both features",
        textStyles: [
          { style: "BOLD", start: 0, length: 7 },
          { style: "SPOILER", start: 13, length: 4 },
        ],
        previews: [
          {
            url: "https://blocked.com",
            title: "Blocked",
            description: "Should not appear",
          },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    // Plain text, no formatting
    expect(capturedCtx?.BodyForCommands).toBe("message with both features");
    expect(capturedCtx?.BodyForCommands).not.toContain("**");
    expect(capturedCtx?.BodyForCommands).not.toContain("||");
    // No link previews in untrusted context
    const untrusted = capturedCtx?.UntrustedContext?.join("\n") ?? "";
    expect(untrusted).not.toContain("Link preview");
    expect(untrusted).not.toContain("https://blocked.com");
  });

  it("applies text styles correctly when message contains mentions", async () => {
    const handler = createTestHandler();

    // Message: "\uFFFC check this out" (16 chars)
    // After mention expansion: "@550e8400-e29b-41d4-a716-446655440000 check this out" (52 chars)
    // Original textStyle BOLD at {start: 2, length: 5} should target "check" in the expanded text
    // After expansion, "check" starts at position 38 (mention is 37 chars: @ + 36-char UUID)
    await handler(
      makeReceiveEvent({
        message: "\uFFFC check this out",
        mentions: [
          {
            uuid: "550e8400-e29b-41d4-a716-446655440000",
            start: 0,
            length: 1,
          },
        ],
        textStyles: [
          { style: "BOLD", start: 2, length: 5 }, // "check" in original message
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    // The mention should be expanded and the BOLD style should apply to "check"
    expect(capturedCtx?.BodyForCommands).toContain("@550e8400-e29b-41d4-a716-446655440000");
    expect(capturedCtx?.BodyForCommands).toContain("**check**");
    expect(capturedCtx?.BodyForCommands).toBe(
      "@550e8400-e29b-41d4-a716-446655440000 **check** this out",
    );
  });
});
