import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../channels/plugins/contract-surfaces.js", () => ({
  getBundledChannelContractSurfaceModule: vi.fn(() => null),
}));

let telegramCommandConfig: typeof import("./telegram-command-config.js");

beforeAll(async () => {
  vi.resetModules();
  telegramCommandConfig = await import("./telegram-command-config.js");
});

describe("telegram command config fallback", () => {
  it("keeps command validation available when the bundled contract surface is unavailable", () => {
    expect(telegramCommandConfig.TELEGRAM_COMMAND_NAME_PATTERN.test("hello_world")).toBe(true);
    expect(telegramCommandConfig.normalizeTelegramCommandName("/Hello-World")).toBe(
      "hello_world",
    );
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
  });
});
