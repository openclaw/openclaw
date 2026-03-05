import type { App } from "@slack/bolt";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { SlackMessageEvent } from "../../types.js";
import { prepareSlackMessage } from "./prepare.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";

function buildCtx(overrides?: { replyToMode?: "all" | "first" | "off" }) {
  const replyToMode = overrides?.replyToMode ?? "all";
  return createInboundSlackTestContext({
    cfg: {
      channels: {
        slack: { enabled: true, replyToMode },
      },
    } as OpenClawConfig,
    appClient: {} as App["client"],
    defaultRequireMention: false,
    replyToMode,
  });
}

function buildChannelMessage(overrides?: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    channel: "C123",
    channel_type: "channel",
    user: "U1",
    text: "hello",
    ts: "1770408518.451689",
    ...overrides,
  } as SlackMessageEvent;
}

describe("thread-level session keys", () => {
  it("keeps top-level channel turns in one session when replyToMode=off", async () => {
    const ctx = buildCtx({ replyToMode: "off" });
    ctx.resolveUserName = async () => ({ name: "Alice" });
    const account = createSlackTestAccount({ replyToMode: "off" });

    const first = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({ ts: "1770408518.451689" }),
      opts: { source: "message" },
    });
    const second = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({ ts: "1770408520.000001" }),
      opts: { source: "message" },
    });

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    const firstSessionKey = first!.ctxPayload.SessionKey as string;
    const secondSessionKey = second!.ctxPayload.SessionKey as string;
    expect(firstSessionKey).toBe(secondSessionKey);
    expect(firstSessionKey).not.toContain(":thread:");
  });

  it("uses parent thread_ts for thread replies even when replyToMode=off", async () => {
    const ctx = buildCtx({ replyToMode: "off" });
    ctx.resolveUserName = async () => ({ name: "Bob" });
    const account = createSlackTestAccount({ replyToMode: "off" });

    const message = buildChannelMessage({
      user: "U2",
      text: "reply",
      ts: "1770408522.168859",
      thread_ts: "1770408518.451689",
    });

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message,
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    // Thread replies should use the parent thread_ts, not the reply ts
    const sessionKey = prepared!.ctxPayload.SessionKey as string;
    expect(sessionKey).toContain(":thread:1770408518.451689");
    expect(sessionKey).not.toContain("1770408522.168859");
  });

  it("keeps one thread session key across different users in the same Slack thread", async () => {
    const ctx = buildCtx({ replyToMode: "off" });
    ctx.resolveUserName = async () => ({ name: "RoomUser" });
    const account = createSlackTestAccount({ replyToMode: "off" });

    const first = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({
        user: "U1",
        text: "thread starter reply",
        ts: "1770408522.168859",
        thread_ts: "1770408518.451689",
      }),
      opts: { source: "message" },
    });
    const second = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({
        user: "U2",
        text: "same thread, different user",
        ts: "1770408523.168859",
        thread_ts: "1770408518.451689",
      }),
      opts: { source: "message" },
    });

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    const firstSessionKey = first!.ctxPayload.SessionKey as string;
    const secondSessionKey = second!.ctxPayload.SessionKey as string;
    expect(firstSessionKey).toBe(secondSessionKey);
    expect(firstSessionKey).toContain(":thread:1770408518.451689");
  });

  it("keeps top-level channel messages on per-channel session unless replyToMode=all", async () => {
    for (const mode of ["all", "first", "off"] as const) {
      const ctx = buildCtx({ replyToMode: mode });
      ctx.resolveUserName = async () => ({ name: "Carol" });
      const account = createSlackTestAccount({ replyToMode: mode });

      const first = await prepareSlackMessage({
        ctx,
        account,
        message: buildChannelMessage({ ts: "1770408530.000000" }),
        opts: { source: "message" },
      });
      const second = await prepareSlackMessage({
        ctx,
        account,
        message: buildChannelMessage({ ts: "1770408531.000000" }),
        opts: { source: "message" },
      });

      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      const firstKey = first!.ctxPayload.SessionKey as string;
      const secondKey = second!.ctxPayload.SessionKey as string;
      if (mode === "all") {
        expect(firstKey).not.toBe(secondKey);
        expect(firstKey).toContain(":thread:1770408530.000000");
        expect(secondKey).toContain(":thread:1770408531.000000");
      } else {
        expect(firstKey).toBe(secondKey);
        expect(firstKey).not.toContain(":thread:");
      }
    }
  });

  it("keeps one session from top-level channel turn into thread replies when replyToMode=all", async () => {
    const ctx = buildCtx({ replyToMode: "all" });
    ctx.resolveUserName = async () => ({ name: "Dave" });
    const account = createSlackTestAccount({ replyToMode: "all" });

    const starterTs = "1770408600.000000";
    const topLevel = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({ ts: starterTs }),
      opts: { source: "message" },
    });
    const reply = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({
        ts: "1770408601.000000",
        thread_ts: starterTs,
        parent_user_id: "U1",
      }),
      opts: { source: "message" },
    });

    expect(topLevel).toBeTruthy();
    expect(reply).toBeTruthy();
    const topLevelKey = topLevel!.ctxPayload.SessionKey as string;
    const replyKey = reply!.ctxPayload.SessionKey as string;
    expect(topLevelKey).toBe(replyKey);
    expect(replyKey).toContain(`:thread:`);
  });

  it("always adds thread suffix for DMs even when replyToMode=off", async () => {
    const ctx = buildCtx({ replyToMode: "off" });
    ctx.resolveUserName = async () => ({ name: "Carol" });
    const account = createSlackTestAccount({ replyToMode: "off" });

    const message: SlackMessageEvent = {
      channel: "D456",
      channel_type: "im",
      user: "U3",
      text: "dm message",
      ts: "1770408530.000000",
    } as SlackMessageEvent;

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message,
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    const sessionKey = prepared!.ctxPayload.SessionKey as string;
    expect(sessionKey).toContain(":thread:1770408530.000000");
  });
});
