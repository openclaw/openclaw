import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

import { processDiscordMessage } from "./message-handler.process.js";

describe("discord processDiscordMessage inbound contract", () => {
  it("passes a finalized MsgContext to dispatchInboundMessage", async () => {
    capturedCtx = undefined;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-"));
    const storePath = path.join(dir, "sessions.json");

    await processDiscordMessage({
<<<<<<< HEAD
      cfg: { messages: {}, session: { store: storePath } } as any,
      discordConfig: {} as any,
      accountId: "default",
      token: "token",
=======
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: {}, session: { store: storePath } } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      discordConfig: {} as any,
      accountId: "default",
      token: "token",
      // oxlint-disable-next-line typescript/no-explicit-any
>>>>>>> upstream/main
      runtime: { log: () => {}, error: () => {} } as any,
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1024,
      textLimit: 4000,
      sender: { label: "user" },
      replyToMode: "off",
      ackReactionScope: "direct",
      groupPolicy: "open",
<<<<<<< HEAD
      data: { guild: null } as any,
=======
      // oxlint-disable-next-line typescript/no-explicit-any
      data: { guild: null } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
>>>>>>> upstream/main
      client: { rest: {} } as any,
      message: {
        id: "m1",
        channelId: "c1",
        timestamp: new Date().toISOString(),
        attachments: [],
<<<<<<< HEAD
=======
        // oxlint-disable-next-line typescript/no-explicit-any
>>>>>>> upstream/main
      } as any,
      author: {
        id: "U1",
        username: "alice",
        discriminator: "0",
        globalName: "Alice",
<<<<<<< HEAD
=======
        // oxlint-disable-next-line typescript/no-explicit-any
>>>>>>> upstream/main
      } as any,
      channelInfo: null,
      channelName: undefined,
      isGuildMessage: false,
      isDirectMessage: true,
      isGroupDm: false,
      commandAuthorized: true,
      baseText: "hi",
      messageText: "hi",
      wasMentioned: false,
      shouldRequireMention: false,
      canDetectMention: false,
      effectiveWasMentioned: false,
      threadChannel: null,
      threadParentId: undefined,
      threadParentName: undefined,
      threadParentType: undefined,
      threadName: undefined,
      displayChannelSlug: "",
      guildInfo: null,
      guildSlug: "",
      channelConfig: null,
      baseSessionKey: "agent:main:discord:dm:u1",
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:discord:dm:u1",
        mainSessionKey: "agent:main:main",
<<<<<<< HEAD
      } as any,
=======
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
>>>>>>> upstream/main
    } as any);

    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx!);
  });
});
