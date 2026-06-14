import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
  registerPluginCliCommandGroups,
  type PluginCliCommandGroupEntry,
} from "./register-plugin-cli-command-groups.js";

describe("registerPluginCliCommandGroups", () => {
  it("skips unreadable CLI descriptor rows while preserving healthy lazy commands", async () => {
    const placeholders = [
      { name: "broken", description: "broken", hasSubcommands: false },
      Object.defineProperty(
        { name: "broken-name", description: "broken name", hasSubcommands: false },
        "name",
        {
          get() {
            throw new Error("plugin CLI descriptor name exploded");
          },
        },
      ),
      { name: "healthy", description: "healthy", hasSubcommands: false },
    ];
    Object.defineProperty(placeholders, "0", {
      get() {
        throw new Error("plugin CLI descriptor row exploded");
      },
    });
    const register = vi.fn();
    const entry: PluginCliCommandGroupEntry = {
      pluginId: "cli-plugin",
      names: ["healthy"],
      placeholders,
      register,
    };
    const program = new Command("openclaw");
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await registerPluginCliCommandGroups(program, [entry], {
      mode: "lazy",
      existingCommands: new Set(),
      logger,
    });

    expect(program.commands.map((command) => command.name())).toEqual(["healthy"]);
    expect(register).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
