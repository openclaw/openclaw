import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";

describe("group runtime loading", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    vi.resetModules();
  });

  it("keeps prompt helpers off the heavy group runtime", async () => {
    const groupsRuntimeLoads = vi.fn();
    vi.doMock("./groups.runtime.js", async (importOriginal) => {
      groupsRuntimeLoads();
      return await importOriginal<typeof import("./groups.runtime.js")>();
    });
    const groups = await import("./groups.js");

    expect(groupsRuntimeLoads).not.toHaveBeenCalled();
    expect(
      groups.buildGroupChatContext({
        sessionCtx: {
          ChatType: "group",
          GroupSubject: "Ops",
          Provider: "whatsapp",
        },
      }),
    ).toContain('You are in the WhatsApp group chat "Ops".');
    expect(
      groups.buildGroupIntro({
        cfg: {} as OpenClawConfig,
        sessionCtx: { Provider: "whatsapp" },
        defaultActivation: "mention",
        silentToken: "NO_REPLY",
      }),
    ).toContain("WhatsApp IDs:");
    expect(groupsRuntimeLoads).not.toHaveBeenCalled();
    vi.doUnmock("./groups.runtime.js");
  });

  it("loads the group runtime only when requireMention resolution needs it", async () => {
    const groupsRuntimeLoads = vi.fn();
    vi.doMock("./groups.runtime.js", async (importOriginal) => {
      groupsRuntimeLoads();
      return await importOriginal<typeof import("./groups.runtime.js")>();
    });
    const groups = await import("./groups.js");

    await expect(
      groups.resolveGroupRequireMention({
        cfg: {
          channels: {
            slack: {
              channels: {
                C123: { requireMention: false },
              },
            },
          },
        },
        ctx: {
          Provider: "slack",
          From: "slack:channel:C123",
          GroupSubject: "#general",
        },
        groupResolution: {
          key: "slack:group:C123",
          channel: "slack",
          id: "C123",
          chatType: "group",
        },
      }),
    ).resolves.toBe(false);
    expect(groupsRuntimeLoads).toHaveBeenCalled();
    vi.doUnmock("./groups.runtime.js");
  });
});

describe("buildGroupChatContext multi-agent awareness", () => {
  it("includes other bots in group context when OtherBotUsernames is set", async () => {
    vi.resetModules();
    const { buildGroupChatContext } = await import("./groups.js");
    const result = buildGroupChatContext({
      sessionCtx: {
        Provider: "telegram",
        GroupSubject: "Dev Chat",
        BotUsername: "mybot",
        OtherBotUsernames: ["otherbot1", "otherbot2"],
      },
    });
    expect(result).toContain("@mybot");
    expect(result).toContain("@otherbot1");
    expect(result).toContain("@otherbot2");
    expect(result).toContain("Do not act on messages clearly addressed to other bots");
  });

  it("does not mention multi-agent when no other bots", async () => {
    vi.resetModules();
    const { buildGroupChatContext } = await import("./groups.js");
    const result = buildGroupChatContext({
      sessionCtx: {
        Provider: "telegram",
        GroupSubject: "Dev Chat",
        BotUsername: "mybot",
      },
    });
    expect(result).toContain("@mybot");
    expect(result).not.toContain("Other bots");
  });

  it("trims whitespace from OtherBotUsernames entries", async () => {
    vi.resetModules();
    const { buildGroupChatContext } = await import("./groups.js");
    const result = buildGroupChatContext({
      sessionCtx: {
        Provider: "telegram",
        GroupSubject: "Dev Chat",
        BotUsername: "mybot",
        OtherBotUsernames: [" helperbot ", "  ", "otherbot"],
      },
    });
    expect(result).toContain("@helperbot");
    expect(result).toContain("@otherbot");
    expect(result).not.toContain("@ helperbot");
    expect(result).not.toContain("@  ");
  });
});

describe("buildGroupIntro multi-agent awareness", () => {
  it("includes multi-agent guidance when OtherBotUsernames is set", async () => {
    vi.resetModules();
    const { buildGroupIntro } = await import("./groups.js");
    const result = buildGroupIntro({
      cfg: {} as OpenClawConfig,
      sessionCtx: {
        Provider: "telegram",
        BotUsername: "mybot",
        OtherBotUsernames: ["helperbot"],
      },
      defaultActivation: "mention",
      silentToken: "__silent__",
    });
    expect(result).toContain("multiple bots");
    expect(result).toContain("@helperbot");
    expect(result).toContain("which bot each message mentioned or replied to");
  });

  it("omits multi-agent line when no other bots present", async () => {
    vi.resetModules();
    const { buildGroupIntro } = await import("./groups.js");
    const result = buildGroupIntro({
      cfg: {} as OpenClawConfig,
      sessionCtx: {
        Provider: "telegram",
        BotUsername: "mybot",
      },
      defaultActivation: "mention",
      silentToken: "__silent__",
    });
    expect(result).not.toContain("multiple bots");
  });
});
