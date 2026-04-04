import { describe, expect, it } from "vitest";
import {
  formatChannelDefaultAccountPath,
  formatChannelAccountsDefaultPath,
  formatSetExplicitDefaultInstruction,
  formatSetExplicitDefaultToConfiguredInstruction,
} from "./default-account-warnings.js";

describe("formatChannelDefaultAccountPath", () => {
  it("formats channel default account path", () => {
    expect(formatChannelDefaultAccountPath("telegram")).toBe("channels.telegram.defaultAccount");
  });
});

describe("formatChannelAccountsDefaultPath", () => {
  it("formats channel accounts default path", () => {
    expect(formatChannelAccountsDefaultPath("discord")).toBe("channels.discord.accounts.default");
  });
});

describe("formatSetExplicitDefaultInstruction", () => {
  it("formats instruction with channel key", () => {
    const result = formatSetExplicitDefaultInstruction("telegram");
    expect(result).toContain("channels.telegram.defaultAccount");
    expect(result).toContain("channels.telegram.accounts.default");
  });
});

describe("formatSetExplicitDefaultToConfiguredInstruction", () => {
  it("formats instruction with params", () => {
    const result = formatSetExplicitDefaultToConfiguredInstruction({ channelKey: "slack" });
    expect(result).toContain("channels.slack.defaultAccount");
    expect(result).toContain("channels.slack.accounts.default");
  });
});
