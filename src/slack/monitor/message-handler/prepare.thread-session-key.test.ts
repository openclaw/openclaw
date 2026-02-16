import type { App } from "@slack/bolt";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { createSlackMonitorContext } from "../context.js";
import { prepareSlackMessage } from "./prepare.js";

// Spy on readSessionUpdatedAt to verify which sessionKey is used.
const readSessionUpdatedAtSpy = vi.fn(() => undefined);
vi.mock("../../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config/sessions.js")>();
  return {
    ...actual,
    readSessionUpdatedAt: (...args: unknown[]) => readSessionUpdatedAtSpy(...args),
  };
});

function buildCtx(overrides?: { replyToMode?: string }) {
  return createSlackMonitorContext({
    cfg: {
      channels: {
        slack: { enabled: true, replyToMode: overrides?.replyToMode ?? "all" },
      },
    } as OpenClawConfig,
    accountId: "default",
    botToken: "token",
    app: { client: {} } as App,
    runtime: {} as RuntimeEnv,
    botUserId: "B1",
    teamId: "T1",
    apiAppId: "A1",
    historyLimit: 0,
    sessionScope: "per-sender",
    mainKey: "main",
    dmEnabled: true,
    dmPolicy: "open",
    allowFrom: [],
    groupDmEnabled: true,
    groupDmChannels: [],
    defaultRequireMention: false,
    groupPolicy: "open",
    useAccessGroups: false,
    reactionMode: "off",
    reactionAllowlist: [],
    replyToMode: overrides?.replyToMode ?? "all",
    threadHistoryScope: "thread",
    threadInheritParent: false,
    slashCommand: {
      enabled: false,
      name: "openclaw",
      sessionPrefix: "slack:slash",
      ephemeral: true,
    },
    textLimit: 4000,
    ackReactionScope: "group-mentions",
    mediaMaxBytes: 1024,
    removeAckAfterReply: false,
  });
}

const account: ResolvedSlackAccount = {
  accountId: "default",
  enabled: true,
  botTokenSource: "config",
  appTokenSource: "config",
  config: {},
};

describe("previousTimestamp uses thread-level session key", () => {
  it("reads previousTimestamp from thread session key for channel messages", async () => {
    readSessionUpdatedAtSpy.mockClear();

    const ctx = buildCtx();
    // oxlint-disable-next-line typescript/no-explicit-any
    ctx.resolveUserName = async () => ({ name: "Alice" }) as any;

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

    // readSessionUpdatedAt should have been called with the thread-level session key,
    // not the base channel key. For a top-level channel message the thread ID is message.ts.
    const calls = readSessionUpdatedAtSpy.mock.calls;
    const envelopeCall = calls.find(
      (c) =>
        typeof c[0] === "object" &&
        c[0] !== null &&
        "sessionKey" in c[0] &&
        typeof (c[0] as Record<string, unknown>).sessionKey === "string" &&
        ((c[0] as Record<string, unknown>).sessionKey as string).includes("thread:"),
    );
    expect(envelopeCall).toBeTruthy();

    // The session key should contain the thread suffix with the message ts
    const usedKey = (envelopeCall![0] as { sessionKey: string }).sessionKey;
    expect(usedKey).toContain(":thread:");
    expect(usedKey).toContain("1770408518.451689");

    // No call should use the bare channel key (without :thread:) for this channel message
    const bareChannelCalls = calls.filter(
      (c) =>
        typeof c[0] === "object" &&
        c[0] !== null &&
        "sessionKey" in c[0] &&
        typeof (c[0] as Record<string, unknown>).sessionKey === "string" &&
        ((c[0] as Record<string, unknown>).sessionKey as string).includes("slack:channel:") &&
        !((c[0] as Record<string, unknown>).sessionKey as string).includes(":thread:"),
    );
    expect(bareChannelCalls).toHaveLength(0);
  });

  it("reads previousTimestamp from thread session key for thread replies", async () => {
    readSessionUpdatedAtSpy.mockClear();

    const ctx = buildCtx();
    // oxlint-disable-next-line typescript/no-explicit-any
    ctx.resolveUserName = async () => ({ name: "Bob" }) as any;

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

    // For a thread reply, the session key should use the parent thread_ts
    const calls = readSessionUpdatedAtSpy.mock.calls;
    const threadCalls = calls.filter(
      (c) =>
        typeof c[0] === "object" &&
        c[0] !== null &&
        "sessionKey" in c[0] &&
        typeof (c[0] as Record<string, unknown>).sessionKey === "string" &&
        ((c[0] as Record<string, unknown>).sessionKey as string).includes(
          ":thread:1770408518.451689",
        ),
    );
    expect(threadCalls.length).toBeGreaterThan(0);
  });

  it("uses base session key for DMs (no thread suffix)", async () => {
    readSessionUpdatedAtSpy.mockClear();

    const ctx = buildCtx();
    // oxlint-disable-next-line typescript/no-explicit-any
    ctx.resolveUserName = async () => ({ name: "Carol" }) as any;

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

    // DMs should NOT have :thread: in the session key (unless it's a thread reply)
    const calls = readSessionUpdatedAtSpy.mock.calls;
    const threadCalls = calls.filter(
      (c) =>
        typeof c[0] === "object" &&
        c[0] !== null &&
        "sessionKey" in c[0] &&
        typeof (c[0] as Record<string, unknown>).sessionKey === "string" &&
        ((c[0] as Record<string, unknown>).sessionKey as string).includes(":thread:"),
    );
    expect(threadCalls).toHaveLength(0);
  });
});
