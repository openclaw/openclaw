import { describe, expect, it } from "vitest";
import { resolveTelegramNativeSessionKey } from "./bot-native-commands.js";

describe("resolveTelegramNativeSessionKey", () => {
  it("routes /status and /stop command words to the dedicated command lane", () => {
    expect(
      resolveTelegramNativeSessionKey({
        prompt: "/status",
        senderId: "123",
        chatId: 456,
        defaultSessionKey: "telegram:slash:123",
      }),
    ).toBe("telegram:commands:123");

    expect(
      resolveTelegramNativeSessionKey({
        prompt: " /stop@openclaw_bot ",
        senderId: "123",
        chatId: 456,
        defaultSessionKey: "telegram:slash:123",
      }),
    ).toBe("telegram:commands:123");
  });

  it("keeps other slash commands on the default slash lane", () => {
    expect(
      resolveTelegramNativeSessionKey({
        prompt: "/status now",
        senderId: "123",
        chatId: 456,
        defaultSessionKey: "telegram:slash:123",
      }),
    ).toBe("telegram:slash:123");

    expect(
      resolveTelegramNativeSessionKey({
        prompt: "/model",
        senderId: "123",
        chatId: 456,
        defaultSessionKey: "telegram:slash:123",
      }),
    ).toBe("telegram:slash:123");
  });
});
