import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import { buildChannelsTable } from "./channels.js";

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(),
}));

function makeMattermostPlugin(): ChannelPlugin {
  return {
    id: "mattermost",
    meta: {
      id: "mattermost",
      label: "Mattermost",
      selectionLabel: "Mattermost",
      docsPath: "/channels/mattermost",
      blurb: "test",
    },
    config: {
      listAccountIds: () => ["echo"],
      defaultAccountId: () => "echo",
      resolveAccount: () => ({
        name: "Echo",
        enabled: true,
        botToken: "bot-token-value",
        baseUrl: "https://mm.example.com",
      }),
      isConfigured: () => true,
      isEnabled: () => true,
    },
    actions: {
      listActions: () => ["send"],
    },
  };
}

describe("buildChannelsTable - mattermost token summary", () => {
  it("does not require appToken for mattermost accounts", async () => {
    vi.mocked(listChannelPlugins).mockReturnValue([makeMattermostPlugin()]);

    const table = await buildChannelsTable({ channels: {} } as never, {
      showSecrets: false,
    });

    const mattermostRow = table.rows.find((row) => row.id === "mattermost");
    expect(mattermostRow).toBeDefined();
    expect(mattermostRow?.state).toBe("ok");
    expect(mattermostRow?.detail).not.toContain("need bot+app");
  });
});
