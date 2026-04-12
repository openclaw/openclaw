import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { applyReplyThreading } from "./reply-payloads-base.js";
import {
  createReplyToModeFilter,
  resolveConfiguredReplyToMode,
  resolveReplyToMode,
  resolveReplyToModeWithThreading,
} from "./reply-threading.js";

const emptyCfg = {} as OpenClawConfig;

describe("reply-threading test setup", () => {
  it("resets plugin runtime state before fallback resolution coverage", () => {
    setActivePluginRegistry(createTestRegistry());
  });
});

describe("resolveReplyToMode", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("falls back to configured channel defaults when channel threading plugins are unavailable", () => {
    const configuredCfg = {
      channels: {
        telegram: { replyToMode: "all" },
        discord: { replyToMode: "first" },
        slack: { replyToMode: "all" },
      },
    } as OpenClawConfig;
    const chatTypeCfg = {
      channels: {
        slack: {
          replyToMode: "off",
          replyToModeByChatType: { direct: "all", group: "first" },
        },
      },
    } as OpenClawConfig;
    const topLevelFallbackCfg = {
      channels: {
        slack: {
          replyToMode: "first",
        },
      },
    } as OpenClawConfig;
    const legacyDmCfg = {
      channels: {
        slack: {
          replyToMode: "off",
          dm: { replyToMode: "all" },
        },
      },
    } as OpenClawConfig;

    const cases: Array<{
      cfg: OpenClawConfig;
      channel?: "telegram" | "discord" | "slack";
      chatType?: "direct" | "group" | "channel";
      expected: "off" | "all" | "first";
    }> = [
      { cfg: emptyCfg, channel: "telegram", expected: "all" },
      { cfg: emptyCfg, channel: "discord", expected: "all" },
      { cfg: emptyCfg, channel: "slack", expected: "all" },
      { cfg: emptyCfg, channel: undefined, expected: "all" },
      { cfg: configuredCfg, channel: "telegram", expected: "all" },
      { cfg: configuredCfg, channel: "discord", expected: "first" },
      { cfg: configuredCfg, channel: "slack", expected: "all" },
      { cfg: chatTypeCfg, channel: "slack", chatType: "direct", expected: "all" },
      { cfg: chatTypeCfg, channel: "slack", chatType: "group", expected: "first" },
      { cfg: chatTypeCfg, channel: "slack", chatType: "channel", expected: "off" },
      { cfg: chatTypeCfg, channel: "slack", chatType: undefined, expected: "off" },
      { cfg: topLevelFallbackCfg, channel: "slack", chatType: "direct", expected: "first" },
      { cfg: topLevelFallbackCfg, channel: "slack", chatType: "channel", expected: "first" },
      { cfg: legacyDmCfg, channel: "slack", chatType: "direct", expected: "all" },
      { cfg: legacyDmCfg, channel: "slack", chatType: "channel", expected: "off" },
    ];
    for (const testCase of cases) {
      expect(resolveReplyToMode(testCase.cfg, testCase.channel, null, testCase.chatType)).toBe(
        testCase.expected,
      );
    }
  });

  it("prefers plugin threading adapters over config fallback when available", () => {
    expect(
      resolveReplyToModeWithThreading(
        {
          channels: {
            slack: {
              replyToMode: "off",
            },
          },
        } as OpenClawConfig,
        {
          resolveReplyToMode: () => "first",
        },
        {
          channel: "slack",
          accountId: "acct-1",
          chatType: "direct",
        },
      ),
    ).toBe("first");
  });
});

describe("resolveConfiguredReplyToMode", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("handles top-level, chat-type, and legacy DM fallback without plugin registry access", () => {
    const cfg = {
      channels: {
        slack: {
          replyToMode: "off",
          replyToModeByChatType: { direct: "all", group: "first" },
          dm: { replyToMode: "all" },
        },
      },
    } as OpenClawConfig;

    expect(resolveConfiguredReplyToMode(cfg, "slack", "direct")).toBe("all");
    expect(resolveConfiguredReplyToMode(cfg, "slack", "group")).toBe("first");
    expect(resolveConfiguredReplyToMode(cfg, "slack", "channel")).toBe("off");
    expect(resolveConfiguredReplyToMode(cfg, "slack", undefined)).toBe("off");
  });
});

describe("agent runner auto replyToMode resolution", () => {
  it("resolves auto to first behavior when WasQueued is true", () => {
    const wasQueued = true;
    const rawReplyToMode = "auto" as const;
    const replyToMode = rawReplyToMode === "auto" ? (wasQueued ? "first" : "off") : rawReplyToMode;
    const filter = createReplyToModeFilter(replyToMode);

    expect(filter({ text: "first", replyToId: "msg-1" }).replyToId).toBe("msg-1");
    expect(filter({ text: "second", replyToId: "msg-1" }).replyToId).toBeUndefined();
  });

  it("resolves auto to off behavior when WasQueued is false or undefined", () => {
    for (const wasQueued of [false, undefined]) {
      const rawReplyToMode = "auto" as const;
      const replyToMode =
        rawReplyToMode === "auto" ? (wasQueued ? "first" : "off") : rawReplyToMode;
      const filter = createReplyToModeFilter(replyToMode);

      expect(filter({ text: "first", replyToId: "msg-1" }).replyToId).toBeUndefined();
      expect(filter({ text: "second", replyToId: "msg-1" }).replyToId).toBeUndefined();
    }
  });
});

describe("auto mode integration with tag system", () => {
  it("injected replyToId + replyToCurrent flows through applyReplyThreading with first mode", () => {
    // Simulates the followup-runner injecting quote info on queued messages
    const payloads = [
      { text: "first reply chunk", replyToId: "msg-42", replyToCurrent: true },
      { text: "second reply chunk", replyToId: "msg-42", replyToCurrent: true },
    ];
    const result = applyReplyThreading({
      payloads,
      replyToMode: "first",
      currentMessageId: "msg-42",
    });

    expect(result[0].replyToId).toBe("msg-42");
    expect(result[1].replyToId).toBeUndefined();
  });

  it("off mode strips replyToId even when replyToCurrent is true", () => {
    const payloads = [{ text: "reply", replyToId: "msg-42", replyToCurrent: true }];
    const result = applyReplyThreading({
      payloads,
      replyToMode: "off",
      currentMessageId: "msg-42",
    });

    expect(result[0].replyToId).toBeUndefined();
  });

  it("off mode strips replyToId even with explicit replyToTag", () => {
    const payloads = [{ text: "reply", replyToId: "msg-42", replyToTag: true }];
    const result = applyReplyThreading({
      payloads,
      replyToMode: "off",
      currentMessageId: "msg-42",
    });

    expect(result[0].replyToId).toBeUndefined();
  });

  it("unresolved auto in filter falls back to off", () => {
    const filter = createReplyToModeFilter("auto");

    expect(filter({ text: "reply", replyToId: "msg-1" }).replyToId).toBeUndefined();
  });

  it("payloads with replyToCurrent false still quote when replyToId is pre-injected", () => {
    // When auto injects replyToId directly, replyToCurrent: false from the model
    // should not block it — the explicit replyToId takes precedence
    const payloads = [{ text: "reply", replyToId: "msg-42", replyToCurrent: false }];
    const result = applyReplyThreading({
      payloads,
      replyToMode: "first",
      currentMessageId: "msg-42",
    });

    // replyToId was pre-set, so resolveReplyThreadingForPayload keeps it
    // (the replyToCurrent === false check only blocks IMPLICIT replyToId)
    expect(result[0].replyToId).toBe("msg-42");
  });

  it("without injected replyToId, replyToCurrent false blocks implicit quoting", () => {
    // This is the normal model behavior — no tag used, no quoting
    const payloads = [{ text: "reply", replyToCurrent: false }];
    const result = applyReplyThreading({
      payloads,
      replyToMode: "first",
      currentMessageId: "msg-42",
    });

    expect(result[0].replyToId).toBeUndefined();
  });
});
