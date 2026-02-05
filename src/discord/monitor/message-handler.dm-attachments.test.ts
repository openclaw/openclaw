/**
 * Tests for Discord DM attachment handling.
 *
 * Bug: DM images show "<media:image> (1 image)" placeholder but don't get downloaded.
 * The resolveMediaList function silently swallows download failures.
 *
 * Expected: MediaPath should be populated when attachments are present.
 * Actual (bug): MediaPath is undefined, only placeholder text appears.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { expectInboundContextContract } from "../../../test/helpers/inbound-contract.js";

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

// Track whether fetchRemoteMedia was called and with what URL
let fetchRemoteMediaCalls: Array<{ url: string; filePathHint?: string }> = [];
let fetchRemoteMediaShouldFail = false;

vi.mock("../../media/fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../media/fetch.js")>();
  return {
    ...actual,
    fetchRemoteMedia: vi.fn(async (options: { url: string; filePathHint?: string }) => {
      fetchRemoteMediaCalls.push(options);
      if (fetchRemoteMediaShouldFail) {
        // Simulate download failure - this is what happens for DM attachments in production
        throw new Error("Failed to fetch: 403 Forbidden");
      }
      // Simulate successful image download
      return {
        buffer: Buffer.from("fake-png-image-data-for-testing"),
        contentType: "image/png",
        fileName: options.filePathHint || "image.png",
      };
    }),
  };
});

import { processDiscordMessage } from "./message-handler.process.js";

describe("discord DM attachments", () => {
  beforeEach(() => {
    capturedCtx = undefined;
    fetchRemoteMediaCalls = [];
    fetchRemoteMediaShouldFail = false;
  });

  it("downloads image attachments from DMs and populates MediaPath", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-dm-"));
    const storePath = path.join(dir, "sessions.json");

    // Mock attachment with typical Discord CDN URL pattern
    const mockAttachment = {
      id: "attachment-123456789",
      filename: "test-image.png",
      content_type: "image/png",
      url: "https://cdn.discordapp.com/attachments/123456789/987654321/test-image.png",
      size: 1024,
    };

    await processDiscordMessage({
      cfg: { messages: {}, session: { store: storePath } } as any,
      discordConfig: {} as any,
      accountId: "default",
      token: "token",
      runtime: { log: () => {}, error: () => {} } as any,
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 8 * 1024 * 1024, // 8MB
      textLimit: 4000,
      replyToMode: "off",
      ackReactionScope: "direct",
      groupPolicy: "open",
      data: { guild: null } as any,
      client: { rest: {} } as any,
      message: {
        id: "dm-msg-1",
        channelId: "dm-channel-123",
        timestamp: new Date().toISOString(),
        attachments: [mockAttachment],
        content: "",
      } as any,
      author: {
        id: "user-123",
        username: "testuser",
        discriminator: "0",
        globalName: "Test User",
      } as any,
      sender: {
        id: "user-123",
        name: "testuser",
        tag: "testuser#0",
        label: "Test User (testuser#0)",
        isPluralKit: false,
      },
      channelInfo: { type: 1 }, // ChannelType.DM = 1
      channelName: undefined,
      isGuildMessage: false,
      isDirectMessage: true,
      isGroupDm: false,
      commandAuthorized: true,
      baseText: "",
      messageText: "<media:image> (1 image)",
      wasMentioned: false,
      shouldRequireMention: false,
      canDetectMention: false,
      effectiveWasMentioned: false,
      shouldBypassMention: false,
      threadChannel: null,
      threadParentId: undefined,
      threadParentName: undefined,
      threadParentType: undefined,
      threadName: undefined,
      displayChannelSlug: "",
      guildInfo: null,
      guildSlug: "",
      channelConfig: null,
      baseSessionKey: "agent:main:discord:dm:user-123",
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:discord:dm:user-123",
        mainSessionKey: "agent:main:main",
      } as any,
    } as any);

    // Verify context was captured
    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx!);

    // BUG TEST: MediaPath should be set when attachments are present
    // The bug causes this to be undefined because downloads silently fail
    expect(capturedCtx!.MediaPath).toBeDefined();
    expect(capturedCtx!.MediaPath).toBeTruthy();
  });

  it("populates MediaPaths array for DM with multiple attachments", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-dm-multi-"));
    const storePath = path.join(dir, "sessions.json");

    const mockAttachments = [
      {
        id: "att-1",
        filename: "photo1.png",
        content_type: "image/png",
        url: "https://cdn.discordapp.com/attachments/dm/att-1/photo1.png",
        size: 1024,
      },
      {
        id: "att-2",
        filename: "photo2.jpg",
        content_type: "image/jpeg",
        url: "https://cdn.discordapp.com/attachments/dm/att-2/photo2.jpg",
        size: 2048,
      },
    ];

    await processDiscordMessage({
      cfg: { messages: {}, session: { store: storePath } } as any,
      discordConfig: {} as any,
      accountId: "default",
      token: "token",
      runtime: { log: () => {}, error: () => {} } as any,
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 8 * 1024 * 1024,
      textLimit: 4000,
      replyToMode: "off",
      ackReactionScope: "direct",
      groupPolicy: "open",
      data: { guild: null } as any,
      client: { rest: {} } as any,
      message: {
        id: "dm-msg-2",
        channelId: "dm-channel-456",
        timestamp: new Date().toISOString(),
        attachments: mockAttachments,
        content: "Check these out",
      } as any,
      author: {
        id: "user-456",
        username: "sender",
        discriminator: "0",
        globalName: "Sender",
      } as any,
      sender: {
        id: "user-456",
        name: "sender",
        tag: "sender#0",
        label: "Sender (sender#0)",
        isPluralKit: false,
      },
      channelInfo: { type: 1 },
      channelName: undefined,
      isGuildMessage: false,
      isDirectMessage: true,
      isGroupDm: false,
      commandAuthorized: true,
      baseText: "Check these out",
      messageText: "Check these out <media:image> (2 images)",
      wasMentioned: false,
      shouldRequireMention: false,
      canDetectMention: false,
      effectiveWasMentioned: false,
      shouldBypassMention: false,
      threadChannel: null,
      threadParentId: undefined,
      threadParentName: undefined,
      threadParentType: undefined,
      threadName: undefined,
      displayChannelSlug: "",
      guildInfo: null,
      guildSlug: "",
      channelConfig: null,
      baseSessionKey: "agent:main:discord:dm:user-456",
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:discord:dm:user-456",
        mainSessionKey: "agent:main:main",
      } as any,
    } as any);

    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx!);

    // BUG TEST: MediaPaths should contain paths for both attachments
    expect(capturedCtx!.MediaPaths).toBeDefined();
    expect(Array.isArray(capturedCtx!.MediaPaths)).toBe(true);
    expect(capturedCtx!.MediaPaths!.length).toBe(2);
  });

  /**
   * BUG REPRODUCTION TEST
   *
   * This test reproduces the actual bug: when download fails for DM attachments,
   * the error is silently swallowed. The message Body contains "<media:image>"
   * placeholder but MediaPath is undefined, giving the user a confusing experience.
   *
   * EXPECTED BEHAVIOR: When download fails, either:
   * 1. MediaPath should still be attempted/retried
   * 2. OR the error should be surfaced in some way (e.g., BodyForAgent mentions failure)
   * 3. OR the placeholder should not appear if media couldn't be downloaded
   *
   * ACTUAL (BUG): Body shows "<media:image> (1 image)" but MediaPath is undefined,
   * and there's no indication to the user/agent that the download failed.
   */
  it("BUG: silently swallows download errors - placeholder shown but no MediaPath", async () => {
    // Enable failure mode to simulate production DM attachment download failure
    fetchRemoteMediaShouldFail = true;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-dm-fail-"));
    const storePath = path.join(dir, "sessions.json");

    const mockAttachment = {
      id: "att-fail-123",
      filename: "failed-image.png",
      content_type: "image/png",
      url: "https://cdn.discordapp.com/attachments/dm/att-fail-123/failed-image.png",
      size: 1024,
    };

    await processDiscordMessage({
      cfg: { messages: {}, session: { store: storePath } } as any,
      discordConfig: {} as any,
      accountId: "default",
      token: "token",
      runtime: { log: () => {}, error: () => {} } as any,
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 8 * 1024 * 1024,
      textLimit: 4000,
      replyToMode: "off",
      ackReactionScope: "direct",
      groupPolicy: "open",
      data: { guild: null } as any,
      client: { rest: {} } as any,
      message: {
        id: "dm-msg-fail",
        channelId: "dm-channel-fail",
        timestamp: new Date().toISOString(),
        attachments: [mockAttachment],
        content: "Here is an image",
      } as any,
      author: {
        id: "user-fail",
        username: "failuser",
        discriminator: "0",
        globalName: "Fail User",
      } as any,
      sender: {
        id: "user-fail",
        name: "failuser",
        tag: "failuser#0",
        label: "Fail User (failuser#0)",
        isPluralKit: false,
      },
      channelInfo: { type: 1 },
      channelName: undefined,
      isGuildMessage: false,
      isDirectMessage: true,
      isGroupDm: false,
      commandAuthorized: true,
      baseText: "Here is an image",
      messageText: "Here is an image <media:image> (1 image)",
      wasMentioned: false,
      shouldRequireMention: false,
      canDetectMention: false,
      effectiveWasMentioned: false,
      shouldBypassMention: false,
      threadChannel: null,
      threadParentId: undefined,
      threadParentName: undefined,
      threadParentType: undefined,
      threadName: undefined,
      displayChannelSlug: "",
      guildInfo: null,
      guildSlug: "",
      channelConfig: null,
      baseSessionKey: "agent:main:discord:dm:user-fail",
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:discord:dm:user-fail",
        mainSessionKey: "agent:main:main",
      } as any,
    } as any);

    expect(capturedCtx).toBeTruthy();

    // Verify download was attempted
    expect(fetchRemoteMediaCalls.length).toBe(1);
    expect(fetchRemoteMediaCalls[0].url).toContain("failed-image.png");

    // THE BUG: Body contains placeholder, suggesting an image is present...
    expect(capturedCtx!.Body).toContain("<media:image>");

    // ...but MediaPath is undefined because download silently failed
    // THIS ASSERTION DEMONSTRATES THE BUG - it currently passes because MediaPath IS undefined
    // A FIX would make this test fail (because MediaPath would be set, or Body wouldn't have placeholder)

    // DESIRED BEHAVIOR: If Body mentions an image, MediaPath should be defined
    // This assertion WILL FAIL with current code, proving the bug exists
    if (capturedCtx!.Body?.includes("<media:image>")) {
      expect(capturedCtx!.MediaPath).toBeDefined();
    }
  });
});
