import { beforeEach, describe, expect, it } from "vitest";
import { setDefaultChannelPluginRegistryForTests } from "../../commands/channel-test-helpers.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { parseExplicitTargetForChannel } from "./target-parsing.js";

describe("parseExplicitTargetForChannel", () => {
  beforeEach(() => {
    setDefaultChannelPluginRegistryForTests();
  });

  it("parses Telegram targets via the registered channel plugin contract", () => {
    expect(parseExplicitTargetForChannel("telegram", "telegram:group:-100123:topic:77")).toEqual({
      to: "-100123",
      threadId: 77,
      chatType: "group",
    });
    expect(parseExplicitTargetForChannel("telegram", "-100123")).toEqual({
      to: "-100123",
      chatType: "group",
    });
  });

  it("parses registered non-bundled channel targets via the active plugin contract", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "msteams",
          source: "test",
          plugin: {
            id: "msteams",
            meta: {
              id: "msteams",
              label: "Microsoft Teams",
              selectionLabel: "Microsoft Teams",
              docsPath: "/channels/msteams",
              blurb: "test stub",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({}),
            },
            messaging: {
              parseExplicitTarget: ({ raw }: { raw: string }) => ({
                to: raw.trim().toUpperCase(),
                chatType: "direct" as const,
              }),
            },
          },
        },
      ]),
    );

    expect(parseExplicitTargetForChannel("msteams", "team-room")).toEqual({
      to: "TEAM-ROOM",
      chatType: "direct",
    });
  });
});
