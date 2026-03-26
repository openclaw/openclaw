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
