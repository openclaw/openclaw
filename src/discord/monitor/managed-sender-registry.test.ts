import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  registerDiscordManagedSender,
  resolveDiscordManagedSenderAccountId,
  unregisterDiscordManagedSender,
} from "./managed-sender-registry.js";

describe("managed sender registry", () => {
  afterEach(() => {
    __testing.clear();
  });

  it("resolves registered Discord bot user ids to account ids", () => {
    registerDiscordManagedSender({ userId: "123", accountId: "bot-1" });

    expect(resolveDiscordManagedSenderAccountId("123")).toBe("bot-1");
  });

  it("ignores unregister requests for a different account id", () => {
    registerDiscordManagedSender({ userId: "123", accountId: "bot-1" });
    unregisterDiscordManagedSender({ userId: "456", accountId: "bot-2" });

    expect(resolveDiscordManagedSenderAccountId("123")).toBe("bot-1");
  });

  it("removes the mapping for the registered account id", () => {
    registerDiscordManagedSender({ userId: "123", accountId: "bot-1" });
    unregisterDiscordManagedSender({ userId: "123", accountId: "bot-1" });

    expect(resolveDiscordManagedSenderAccountId("123")).toBeUndefined();
  });
});
