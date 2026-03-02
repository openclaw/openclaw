import type { App } from "@slack/bolt";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
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

const account: ResolvedSlackAccount = createSlackTestAccount();

describe("thread-level session keys", () => {
  it("uses thread-level session key for channel messages", async () => {
    const ctx = buildCtx();
    ctx.resolveUserName = async () => ({ name: "Alice" });

    const message: SlackMessageEvent = {
      channel: "C123",
      channel_type: "channel",
      user: "U1",
      text: "hello",
      ts: "1770408518.451689",
    } as SlackMessageEvent;

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message,
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    // Channel messages should get thread-level session key with :thread: suffix
    // The resolved session key is in ctxPayload.SessionKey, not route.sessionKey
    const sessionKey = prepared!.ctxPayload.SessionKey as string;
    expect(sessionKey).toContain(":thread:");
    expect(sessionKey).toContain("1770408518.451689");
  });

  it("uses parent thread_ts for thread replies", async () => {
    const ctx = buildCtx();
    ctx.resolveUserName = async () => ({ name: "Bob" });

    const message: SlackMessageEvent = {
      channel: "C123",
      channel_type: "channel",
      user: "U2",
      text: "reply",
      ts: "1770408522.168859",
      thread_ts: "1770408518.451689",
    } as SlackMessageEvent;

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

  it("does not add thread suffix for DMs", async () => {
    const ctx = buildCtx();
    ctx.resolveUserName = async () => ({ name: "Carol" });

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
