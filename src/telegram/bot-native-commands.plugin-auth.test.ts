import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import {
  createNativeCommandsHarness,
  deliverReplies,
  executePluginCommand,
  getPluginCommandSpecs,
  matchPluginCommand,
} from "./bot-native-commands.test-helpers.js";

describe("registerTelegramNativeCommands (plugin auth)", () => {
  it("does not register plugin commands in menu when native=false but keeps handlers available", () => {
    const specs = Array.from({ length: 101 }, (_, i) => ({
      name: `cmd_${i}`,
      description: `Command ${i}`,
    }));
    getPluginCommandSpecs.mockReturnValue(specs);

    const { handlers, setMyCommands, log } = createNativeCommandsHarness({
      cfg: {} as OpenClawConfig,
      telegramCfg: {} as TelegramAccountConfig,
      nativeEnabled: false,
    });

    expect(setMyCommands).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("registering first 100"));
    expect(Object.keys(handlers)).toHaveLength(101);
  });

  it("allows requireAuth:false plugin command even when sender is unauthorized", async () => {
    const command = {
      name: "plugin",
      description: "Plugin command",
      requireAuth: false,
      handler: vi.fn(),
    } as const;

    getPluginCommandSpecs.mockReturnValue([{ name: "plugin", description: "Plugin command" }]);
    matchPluginCommand.mockReturnValue({ command, args: undefined });
    executePluginCommand.mockResolvedValue({ text: "ok" });

    const { handlers, bot } = createNativeCommandsHarness({
      cfg: {} as OpenClawConfig,
      telegramCfg: {} as TelegramAccountConfig,
      allowFrom: ["999"],
      nativeEnabled: false,
    });

    const ctx = {
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 111, username: "nope" },
        message_id: 10,
        date: 123456,
      },
      match: "",
    };

    await handlers.plugin?.(ctx);

    expect(matchPluginCommand).toHaveBeenCalled();
    expect(executePluginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        isAuthorizedSender: false,
      }),
    );
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "ok" }],
      }),
    );
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});
