import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildSlackThreadingToolContext } from "./threading-tool-context.js";

const emptyCfg = {} as OpenClawConfig;

function resolveReplyToModeWithConfig(params: {
  slackConfig: Record<string, unknown>;
  context: Record<string, unknown>;
}) {
  const cfg = {
    channels: {
      slack: params.slackConfig,
    },
  } as OpenClawConfig;
  const result = buildSlackThreadingToolContext({
    cfg,
    accountId: null,
    context: params.context as never,
  });
  return result.replyToMode;
}

describe("buildSlackThreadingToolContext", () => {
  it("uses top-level replyToMode by default", () => {
    const cfg = {
      channels: {
        slack: { replyToMode: "first" },
      },
    } as OpenClawConfig;
    const result = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      context: { ChatType: "channel" },
    });
    expect(result.replyToMode).toBe("first");
  });

  it("uses chat-type replyToMode overrides for direct messages when configured", () => {
    expect(
      resolveReplyToModeWithConfig({
        slackConfig: {
          replyToMode: "off",
          replyToModeByChatType: { direct: "all" },
        },
        context: { ChatType: "direct" },
      }),
    ).toBe("all");
  });

  it("uses top-level replyToMode for channels when no channel override is set", () => {
    expect(
      resolveReplyToModeWithConfig({
        slackConfig: {
          replyToMode: "off",
          replyToModeByChatType: { direct: "all" },
        },
        context: { ChatType: "channel" },
      }),
    ).toBe("off");
  });

  it("falls back to top-level when no chat-type override is set", () => {
    const cfg = {
      channels: {
        slack: {
          replyToMode: "first",
        },
      },
    } as OpenClawConfig;
    const result = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      context: { ChatType: "direct" },
    });
    expect(result.replyToMode).toBe("first");
  });

  it("uses legacy dm.replyToMode for direct messages when no chat-type override exists", () => {
    expect(
      resolveReplyToModeWithConfig({
        slackConfig: {
          replyToMode: "off",
          dm: { replyToMode: "all" },
        },
        context: { ChatType: "direct" },
      }),
    ).toBe("all");
  });

  it("uses all mode when MessageThreadId is present", () => {
    expect(
      resolveReplyToModeWithConfig({
        slackConfig: {
          replyToMode: "all",
          replyToModeByChatType: { direct: "off" },
        },
        context: {
          ChatType: "direct",
          ThreadLabel: "thread-label",
          MessageThreadId: "1771999998.834199",
        },
      }),
    ).toBe("all");
  });

  it("does not force all mode from ThreadLabel alone", () => {
    expect(
      resolveReplyToModeWithConfig({
        slackConfig: {
          replyToMode: "all",
          replyToModeByChatType: { direct: "off" },
        },
        context: {
          ChatType: "direct",
          ThreadLabel: "label-without-real-thread",
        },
      }),
    ).toBe("off");
  });

  it("keeps configured channel behavior when not in a thread", () => {
    const cfg = {
      channels: {
        slack: {
          replyToMode: "off",
          replyToModeByChatType: { channel: "first" },
        },
      },
    } as OpenClawConfig;
    const result = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      context: { ChatType: "channel", ThreadLabel: "label-only" },
    });
    expect(result.replyToMode).toBe("first");
  });

  it("defaults to off when no replyToMode is configured", () => {
    const result = buildSlackThreadingToolContext({
      cfg: emptyCfg,
      accountId: null,
      context: { ChatType: "direct" },
    });
    expect(result.replyToMode).toBe("off");
  });

  it("extracts currentChannelId from channel: prefixed To", () => {
    const result = buildSlackThreadingToolContext({
      cfg: emptyCfg,
      accountId: null,
      context: { ChatType: "channel", To: "channel:C1234ABC" },
    });
    expect(result.currentChannelId).toBe("C1234ABC");
  });

  it("stores user: address in currentDmUserId for DMs, keeps currentChannelId as native D… ID", () => {
    const result = buildSlackThreadingToolContext({
      cfg: emptyCfg,
      accountId: null,
      context: { ChatType: "direct", To: "user:U0AC3LBA08M", NativeChannelId: "D8SRXRDNF" },
    });
    // currentChannelId must be the native D… channel ID so Slack channel actions
    // (react, read, edit, delete, pins) can infer the correct target without hitting
    // resolveSlackChannelId with a user: address it would reject.
    expect(result.currentChannelId).toBe("D8SRXRDNF");
    // currentDmUserId carries the user: address for resolveSlackAutoThreadId matching.
    expect(result.currentDmUserId).toBe("user:U0AC3LBA08M");
  });

  it("uses NativeChannelId as fallback when To is absent", () => {
    const result = buildSlackThreadingToolContext({
      cfg: emptyCfg,
      accountId: null,
      context: {
        ChatType: "direct",
        NativeChannelId: "D8SRXRDNF",
      },
    });
    expect(result.currentChannelId).toBe("D8SRXRDNF");
  });

  it("returns undefined currentChannelId when To is absent and NativeChannelId is not set", () => {
    const result = buildSlackThreadingToolContext({
      cfg: emptyCfg,
      accountId: null,
      context: { ChatType: "direct" },
    });
    expect(result.currentChannelId).toBeUndefined();
  });
});
