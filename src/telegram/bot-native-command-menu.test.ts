import { describe, expect, it, vi } from "vitest";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  filterTelegramMenuCommands,
  syncTelegramMenuCommands,
} from "./bot-native-command-menu.js";

describe("bot-native-command-menu", () => {
  it("caps menu entries to Telegram limit", () => {
    const allCommands = Array.from({ length: 105 }, (_, i) => ({
      command: `cmd_${i}`,
      description: `Command ${i}`,
    }));

    const result = buildCappedTelegramMenuCommands({ allCommands });

    expect(result.commandsToRegister).toHaveLength(100);
    expect(result.totalCommands).toBe(105);
    expect(result.maxCommands).toBe(100);
    expect(result.overflowCount).toBe(5);
    expect(result.commandsToRegister[0]).toEqual({ command: "cmd_0", description: "Command 0" });
    expect(result.commandsToRegister[99]).toEqual({
      command: "cmd_99",
      description: "Command 99",
    });
  });

  it("validates plugin command specs and reports conflicts", () => {
    const existingCommands = new Set(["native"]);

    const result = buildPluginTelegramMenuCommands({
      specs: [
        { name: "valid", description: "  Works  " },
        { name: "bad-name!", description: "Bad" },
        { name: "native", description: "Conflicts with native" },
        { name: "valid", description: "Duplicate plugin name" },
        { name: "empty", description: "   " },
      ],
      existingCommands,
    });

    expect(result.commands).toEqual([{ command: "valid", description: "Works" }]);
    expect(result.issues).toContain(
      'Plugin command "/bad-name!" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).',
    );
    expect(result.issues).toContain(
      'Plugin command "/native" conflicts with an existing Telegram command.',
    );
    expect(result.issues).toContain('Plugin command "/valid" is duplicated.');
    expect(result.issues).toContain('Plugin command "/empty" is missing a description.');
  });

  it("deletes stale commands before setting new menu", async () => {
    const callOrder: string[] = [];
    const deleteMyCommands = vi.fn(async () => {
      callOrder.push("delete");
    });
    const setMyCommands = vi.fn(async () => {
      callOrder.push("set");
    });

    syncTelegramMenuCommands({
      bot: {
        api: {
          deleteMyCommands,
          setMyCommands,
        },
      } as unknown as Parameters<typeof syncTelegramMenuCommands>[0]["bot"],
      runtime: {} as Parameters<typeof syncTelegramMenuCommands>[0]["runtime"],
      commandsToRegister: [{ command: "cmd", description: "Command" }],
    });

    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });

    expect(callOrder).toEqual(["delete", "set"]);
  });
});

describe("filterTelegramMenuCommands", () => {
  const commands = [
    { command: "start", description: "Start the bot" },
    { command: "help", description: "Show help" },
    { command: "settings", description: "Open settings" },
    { command: "status", description: "Show status" },
  ];

  it("returns all commands when no include or exclude is set", () => {
    const result = filterTelegramMenuCommands({ commands });
    expect(result).toEqual(commands);
  });

  it("returns all commands when include is an empty array", () => {
    const result = filterTelegramMenuCommands({ commands, include: [] });
    expect(result).toEqual(commands);
  });

  it("returns all commands when exclude is an empty array", () => {
    const result = filterTelegramMenuCommands({ commands, exclude: [] });
    expect(result).toEqual(commands);
  });

  it("filters to only included commands (whitelist)", () => {
    const result = filterTelegramMenuCommands({
      commands,
      include: ["start", "help"],
    });
    expect(result).toEqual([
      { command: "start", description: "Start the bot" },
      { command: "help", description: "Show help" },
    ]);
  });

  it("excludes specified commands (blacklist)", () => {
    const result = filterTelegramMenuCommands({
      commands,
      exclude: ["settings", "status"],
    });
    expect(result).toEqual([
      { command: "start", description: "Start the bot" },
      { command: "help", description: "Show help" },
    ]);
  });

  it("include takes priority over exclude", () => {
    const result = filterTelegramMenuCommands({
      commands,
      include: ["start"],
      exclude: ["start"],
    });
    expect(result).toEqual([{ command: "start", description: "Start the bot" }]);
  });

  it("normalizes command names by stripping / prefix", () => {
    const result = filterTelegramMenuCommands({
      commands,
      include: ["/start", "/help"],
    });
    expect(result).toEqual([
      { command: "start", description: "Start the bot" },
      { command: "help", description: "Show help" },
    ]);
  });

  it("normalizes command names to lowercase", () => {
    const result = filterTelegramMenuCommands({
      commands,
      include: ["START", "Help"],
    });
    expect(result).toEqual([
      { command: "start", description: "Start the bot" },
      { command: "help", description: "Show help" },
    ]);
  });

  it("returns empty array when include has no matching commands", () => {
    const result = filterTelegramMenuCommands({
      commands,
      include: ["nonexistent"],
    });
    expect(result).toEqual([]);
  });
});
