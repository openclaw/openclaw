import type { Bot } from "grammy";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { hashCommandList, syncTelegramMenuCommands } from "./bot-native-command-menu.js";

describe("Telegram command menu fix (#35285)", () => {
  const createMockBot = (deleteSucceeds = true, setSucceeds = true) => {
    const deleteMock = vi.fn();
    const setMock = vi.fn();

    if (deleteSucceeds) {
      deleteMock.mockResolvedValue(undefined);
    } else {
      deleteMock.mockRejectedValue(new Error("delete failed"));
    }

    if (setSucceeds) {
      setMock.mockResolvedValue(undefined);
    } else {
      setMock.mockRejectedValue(new Error("set failed"));
    }

    return {
      api: {
        deleteMyCommands: deleteMock,
        setMyCommands: setMock,
      },
    } as unknown as Bot;
  };

  const createMockRuntime = () => {
    return {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;
  };

  const commands1 = [
    { command: "weather", description: "Get weather" },
    { command: "gog", description: "Search GOG" },
    { command: "github", description: "GitHub commands" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("hashCommandList", () => {
    it("should produce stable hash for same commands", () => {
      const hash1 = hashCommandList(commands1);
      const hash2 = hashCommandList(commands1);
      expect(hash1).toBe(hash2);
    });

    it("should produce different hash for different commands", () => {
      const commands2 = [
        { command: "weather", description: "Get weather" },
        { command: "gog", description: "Search GOG" },
      ];
      const hash1 = hashCommandList(commands1);
      const hash2 = hashCommandList(commands2);
      expect(hash1).not.toBe(hash2);
    });

    it("should produce same hash regardless of input order", () => {
      const commandsReordered = [
        { command: "github", description: "GitHub commands" },
        { command: "weather", description: "Get weather" },
        { command: "gog", description: "Search GOG" },
      ];
      const hash1 = hashCommandList(commands1);
      const hash2 = hashCommandList(commandsReordered);
      expect(hash1).toBe(hash2);
    });
  });

  describe("syncTelegramMenuCommands", () => {
    it("should always call deleteMyCommands before setMyCommands", async () => {
      const bot = createMockBot(true, true);
      const runtime = createMockRuntime();

      syncTelegramMenuCommands({
        bot: bot as unknown as typeof bot,
        runtime,
        commandsToRegister: commands1,
        accountId: "test-account",
        botIdentity: "test-bot",
      });

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(bot.api.deleteMyCommands).toHaveBeenCalled();
      expect(bot.api.setMyCommands).toHaveBeenCalled();

      // Verify delete is called before set
      const deleteCallOrder = (
        bot.api.deleteMyCommands as unknown as typeof bot.api.deleteMyCommands
      ).mock.invocationCallOrder[0];
      const setCallOrder = (bot.api.setMyCommands as unknown as typeof bot.api.setMyCommands).mock
        .invocationCallOrder[0];
      expect(deleteCallOrder).toBeLessThan(setCallOrder);
    });

    it("should skip setMyCommands when commands unchanged and delete succeeded", async () => {
      const bot = createMockBot(true, true);
      const runtime = createMockRuntime();

      // First sync
      syncTelegramMenuCommands({
        bot: bot as unknown as typeof bot,
        runtime,
        commandsToRegister: commands1,
        accountId: "test-account",
        botIdentity: "test-bot",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Second sync with same commands
      syncTelegramMenuCommands({
        bot: bot as unknown as typeof bot,
        runtime,
        commandsToRegister: commands1,
        accountId: "test-account",
        botIdentity: "test-bot",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Delete should be called twice (once per sync)
      expect(bot.api.deleteMyCommands).toHaveBeenCalledTimes(2);
      // Set should only be called once (second time skipped due to hash match)
      expect(bot.api.setMyCommands).toHaveBeenCalledTimes(1);
    });

    it("should call setMyCommands even when hash matches if delete failed", async () => {
      const bot = createMockBot(false, true); // delete fails
      const runtime = createMockRuntime();

      syncTelegramMenuCommands({
        bot: bot as unknown as typeof bot,
        runtime,
        commandsToRegister: commands1,
        accountId: "test-account",
        botIdentity: "test-bot",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Both delete and set should be called
      expect(bot.api.deleteMyCommands).toHaveBeenCalled();
      expect(bot.api.setMyCommands).toHaveBeenCalled();

      // Error should be logged
      expect(runtime.error).toHaveBeenCalled();
    });

    it("should handle empty command list", async () => {
      const bot = createMockBot(true, true);
      const runtime = createMockRuntime();

      syncTelegramMenuCommands({
        bot: bot as unknown as typeof bot,
        runtime,
        commandsToRegister: [],
        accountId: "test-account",
        botIdentity: "test-bot",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Only delete should be called, not set
      expect(bot.api.deleteMyCommands).toHaveBeenCalled();
      expect(bot.api.setMyCommands).not.toHaveBeenCalled();
    });

    it("should retry with reduced commands on BOT_COMMANDS_TOO_MUCH error", async () => {
      const bot = createMockBot(true, false);
      // Simulate BOT_COMMANDS_TOO_MUCH error
      (bot.api.setMyCommands as unknown as typeof bot.api.setMyCommands).mockRejectedValueOnce({
        description: "BOT_COMMANDS_TOO_MUCH",
      });

      const runtime = createMockRuntime();
      const manyCommands = Array.from({ length: 150 }, (_, i) => ({
        command: `cmd${i}`,
        description: `Command ${i}`,
      }));

      syncTelegramMenuCommands({
        bot: bot as unknown as typeof bot,
        runtime,
        commandsToRegister: manyCommands,
        accountId: "test-account",
        botIdentity: "test-bot",
      });
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should retry with reduced count
      expect(bot.api.setMyCommands).toHaveBeenCalledTimes(2);
    });
  });
});
