import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildChannelAccountSummary } from "./account-summary.js";
import type { ChannelPlugin } from "./plugins/types.plugin.js";

describe("buildChannelAccountSummary", () => {
  it.each(["sync", "async"])(
    "redacts a raw baseUrl from %s account description without mutating the account",
    async (mode) => {
      const rawBaseUrl = [
        "https://",
        "user",
        ":",
        "pass",
        "@",
        "chat.example.test/?token=",
        "secret",
      ].join("");
      const account = Object.freeze({
        baseUrl: "https://safe.example.test/",
      });
      const plugin = {
        config: {
          describeAccount: () => ({
            baseUrl: mode === "sync" ? rawBaseUrl : "https://stale.example.test/",
          }),
          ...(mode === "async"
            ? { describeAccountAsync: async () => ({ baseUrl: rawBaseUrl }) }
            : {}),
        },
      } as unknown as ChannelPlugin;

      const snapshot = await buildChannelAccountSummary({
        plugin,
        account,
        cfg: {} as OpenClawConfig,
        accountId: "default",
        enabled: true,
        configured: true,
      });

      expect(snapshot.baseUrl).toBe("https://chat.example.test/?token=***");
      expect(account.baseUrl).toBe("https://safe.example.test/");
    },
  );
});
