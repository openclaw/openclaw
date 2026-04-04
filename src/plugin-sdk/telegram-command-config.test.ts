import { describe, expect, it, vi } from "vitest";

const getBundledChannelContractSurfaceModule = vi.fn(() => null);

vi.mock("../channels/plugins/contract-surfaces.js", () => ({
  getBundledChannelContractSurfaceModule,
}));

async function loadTelegramCommandConfig() {
  vi.resetModules();
  getBundledChannelContractSurfaceModule.mockClear();
  return import("./telegram-command-config.js");
}

describe("telegram command config fallback", () => {
  it("keeps import-time regex access side-effect free", async () => {
    const telegramCommandConfig = await loadTelegramCommandConfig();

    expect(getBundledChannelContractSurfaceModule).not.toHaveBeenCalled();
    expect(telegramCommandConfig.TELEGRAM_COMMAND_NAME_PATTERN.test("hello_world")).toBe(true);
    expect(getBundledChannelContractSurfaceModule).not.toHaveBeenCalled();
  });

  it("lazy-loads the contract pattern only when callers opt in", async () => {
    const telegramCommandConfig = await loadTelegramCommandConfig();

    expect(telegramCommandConfig.getTelegramCommandNamePattern().test("hello_world")).toBe(true);
    expect(getBundledChannelContractSurfaceModule).toHaveBeenCalledTimes(1);
    expect(telegramCommandConfig.getTelegramCommandNamePattern()).toBe(
      telegramCommandConfig.getTelegramCommandNamePattern(),
    );
    expect(getBundledChannelContractSurfaceModule).toHaveBeenCalledTimes(1);
  });

  it("keeps command validation available when the bundled contract surface is unavailable", async () => {
    const telegramCommandConfig = await loadTelegramCommandConfig();

    expect(telegramCommandConfig.TELEGRAM_COMMAND_NAME_PATTERN.test("hello_world")).toBe(true);
    expect(telegramCommandConfig.normalizeTelegramCommandName("/Hello-World")).toBe("hello_world");
    expect(telegramCommandConfig.normalizeTelegramCommandDescription("  hi  ")).toBe("hi");

    expect(
      telegramCommandConfig.resolveTelegramCustomCommands({
        commands: [
          { command: "/Hello-World", description: "  Says hi  " },
          { command: "/Hello-World", description: "duplicate" },
          { command: "", description: "missing command" },
          { command: "/ok", description: "" },
        ],
      }),
    ).toEqual({
      commands: [{ command: "hello_world", description: "Says hi" }],
      issues: [
        {
          index: 1,
          field: "command",
          message: 'Telegram custom command "/hello_world" is duplicated.',
        },
        {
          index: 2,
          field: "command",
          message: "Telegram custom command is missing a command name.",
        },
        {
          index: 3,
          field: "description",
          message: 'Telegram custom command "/ok" is missing a description.',
        },
      ],
    });
    expect(getBundledChannelContractSurfaceModule).toHaveBeenCalledTimes(1);
  });
});
