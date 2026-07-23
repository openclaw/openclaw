import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildChannelAccountSnapshotFromAccount } from "./status.js";
import type { ChannelPlugin } from "./types.plugin.js";

describe("buildChannelAccountSnapshotFromAccount", () => {
  it("redacts a hook-provided base URL without mutating the account", async () => {
    const baseUrl = [
      "https://",
      "user",
      ":",
      "pass",
      "@",
      "chat.example.test/?token=",
      "secret",
    ].join("");
    const account = Object.freeze({ baseUrl });
    const plugin = {
      config: {},
      status: {
        buildAccountSnapshot: ({ account: hookAccount }: { account: typeof account }) => ({
          accountId: "custom",
          baseUrl: hookAccount.baseUrl,
        }),
      },
    } as unknown as ChannelPlugin<typeof account>;

    const snapshot = await buildChannelAccountSnapshotFromAccount({
      plugin,
      cfg: {} as OpenClawConfig,
      accountId: "default",
      account,
    });

    expect(snapshot.baseUrl).toBe("https://chat.example.test/?token=***");
    expect(account.baseUrl).toBe(baseUrl);
  });
});
