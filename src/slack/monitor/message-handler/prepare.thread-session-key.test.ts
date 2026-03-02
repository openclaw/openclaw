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

  it("keeps top-level channel turns thread-scoped when replyToMode=all", async () => {
    const ctx = buildCtx({ replyToMode: "all" });
    ctx.resolveUserName = async () => ({ name: "Carol" });
    const account = createSlackTestAccount({ replyToMode: "all" });

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({ ts: "1770408530.000000" }),
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    const sessionKey = prepared!.ctxPayload.SessionKey as string;
    expect(sessionKey).toContain(":thread:1770408530.000000");
  });

  it("does not add thread suffix for DMs when replyToMode=off", async () => {
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
    // DMs should NOT have :thread: in the session key
    const sessionKey = prepared!.ctxPayload.SessionKey as string;
    expect(sessionKey).not.toContain(":thread:");
  });
});
