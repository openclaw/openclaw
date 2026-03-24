import { afterEach, describe, expect, it } from "vitest";
import {
  getBotName,
  registerBotName,
  resolveBotName,
  unregisterBotName,
} from "./bot-name-registry.js";

// Clean up registry state between tests by unregistering all test entries.
afterEach(() => {
  unregisterBotName("feishu", "default");
  unregisterBotName("feishu", "cli_abc");
  unregisterBotName("slack", "default");
  unregisterBotName("slack", "W12345");
  unregisterBotName("discord", "default");
});

describe("bot-name-registry", () => {
  describe("cross-channel isolation (regression)", () => {
    it("Feishu and Slack registrations under 'default' do not bleed across channels", () => {
      registerBotName("feishu", "default", "FeishuBot");
      registerBotName("slack", "default", "SlackBot");

      expect(getBotName("feishu", "default")).toBe("FeishuBot");
      expect(getBotName("slack", "default")).toBe("SlackBot");
    });
  });

  describe("getBotName", () => {
    it("returns the registered name for a (channelId, accountId) pair", () => {
      registerBotName("feishu", "cli_abc", "MyFeishuBot");
      expect(getBotName("feishu", "cli_abc")).toBe("MyFeishuBot");
    });

    it("returns undefined for an unknown combination", () => {
      expect(getBotName("feishu", "cli_abc")).toBeUndefined();
    });
  });

  describe("unregisterBotName", () => {
    it("removes only the target (channelId, accountId), not others", () => {
      registerBotName("feishu", "default", "FeishuBot");
      registerBotName("slack", "default", "SlackBot");

      unregisterBotName("feishu", "default");

      expect(getBotName("feishu", "default")).toBeUndefined();
      // Slack entry must be untouched.
      expect(getBotName("slack", "default")).toBe("SlackBot");
    });
  });

  describe("resolveBotName", () => {
    it("returns the exact match when both channelId and accountId are provided", () => {
      registerBotName("feishu", "cli_abc", "ExactBot");
      expect(resolveBotName("feishu", "cli_abc")).toBe("ExactBot");
    });

    it("falls back to (channelId, 'default') when accountId is undefined", () => {
      registerBotName("feishu", "default", "DefaultBot");
      expect(resolveBotName("feishu", undefined)).toBe("DefaultBot");
    });

    it("returns undefined when channelId is undefined", () => {
      registerBotName("feishu", "default", "DefaultBot");
      expect(resolveBotName(undefined, "default")).toBeUndefined();
    });

    it("returns undefined when neither exact nor default entry exists", () => {
      expect(resolveBotName("discord", "default")).toBeUndefined();
    });
  });
});
